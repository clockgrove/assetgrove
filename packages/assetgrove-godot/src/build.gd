# The Godot pack's build script (@clockgrove/assetgrove-godot): an editor plugin of the scratch
# project the pack lays out for one hand-off. Godot's headless editor imports the media; this
# script first checks that it runs on the Godot release the input names (the pinned 4.7.2-stable),
# then builds the resource the input asks for through Godot's API from the input the pack wrote as
# data: a SpriteFrames (godot:sprite-frames), or a TileSet (godot:tile-set, `"build": "tile-set"`).
# It saves it with ResourceSaver (keeping the target's UID when it had one), reloads it with
# ResourceLoader and checks what came back. It writes `.assetgrove-godot/result.json` and quits:
# 0 when everything held, 1 otherwise. Every failure is also printed as an ERROR line, which the
# pack treats as a failed run whatever the exit code.
@tool
extends EditorPlugin

const INPUT := "res://.assetgrove-godot/input.json"
const RESULT := "res://.assetgrove-godot/result.json"
## How long the editor may take to import the media before the run gives up.
const IMPORT_TIMEOUT_MS := 240000
## The corner peering bits of a square tile, by the corner's name in the input.
const CORNERS := {
	"nw": TileSet.CELL_NEIGHBOR_TOP_LEFT_CORNER,
	"ne": TileSet.CELL_NEIGHBOR_TOP_RIGHT_CORNER,
	"sw": TileSet.CELL_NEIGHBOR_BOTTOM_LEFT_CORNER,
	"se": TileSet.CELL_NEIGHBOR_BOTTOM_RIGHT_CORNER,
}
## Each corner's bit in a corner-16 tile index, set where the corner is the upper terrain.
const CORNER_BITS := {"nw": 1, "ne": 2, "sw": 4, "se": 8}

var _errors: PackedStringArray = []


func _enter_tree() -> void:
	_run.call_deferred()


func _fail(message: String) -> void:
	_errors.append(message)
	push_error("assetgrove-godot: " + message)


func _run() -> void:
	var result := {}
	var input = _read_input()
	if input != null:
		_check_version(input)
	if input != null and _errors.is_empty():
		await _wait_for_import(input)
		if _errors.is_empty():
			if String(input.get("build", "")) == "tile-set":
				result = _build_tile_set(input)
			else:
				result = _build_frames(input)
	result["errors"] = _errors
	result["ok"] = _errors.is_empty()
	var out := FileAccess.open(RESULT, FileAccess.WRITE)
	if out == null:
		push_error("assetgrove-godot: cannot write the result")
	else:
		out.store_string(JSON.stringify(result, "  "))
		out.close()
	get_tree().quit(0 if _errors.is_empty() else 1)


func _read_input():
	var text := FileAccess.get_file_as_string(INPUT)
	var input = JSON.parse_string(text)
	if typeof(input) != TYPE_DICTIONARY:
		_fail("the input is not a JSON object")
		return null
	return input


## Fails unless this Godot is the release the input names, such as `4.7.2-stable`.
func _check_version(input: Dictionary) -> void:
	var info := Engine.get_version_info()
	var running := "%d.%d.%d-%s" % [info["major"], info["minor"], info["patch"], info["status"]]
	if running != String(input.get("godot", "")):
		_fail("this is Godot %s, not the pinned %s" % [running, input.get("godot", "")])


## Waits until the editor's file system has scanned and imported every file the build loads:
## each has its `.import`, and every file that `.import` remaps it to exists.
func _wait_for_import(input: Dictionary) -> void:
	var fs := EditorInterface.get_resource_filesystem()
	var paths: Array = []
	if input.has("imports"):
		paths = input["imports"]
	else:
		for animation in input["animations"]:
			paths.append(String(animation["texture"]))
	var started := Time.get_ticks_msec()
	while true:
		var pending := fs.is_scanning()
		for path in paths:
			if not _imported(String(path)):
				pending = true
		if not pending:
			return
		if Time.get_ticks_msec() - started > IMPORT_TIMEOUT_MS:
			_fail("the editor did not import the media in time")
			return
		await get_tree().process_frame


func _imported(path: String) -> bool:
	if not FileAccess.file_exists(path + ".import"):
		return false
	var config := ConfigFile.new()
	if config.load(path + ".import") != OK or not config.has_section("remap"):
		return true
	for key in config.get_section_keys("remap"):
		if key.begins_with("path") and not FileAccess.file_exists(String(config.get_value("remap", key))):
			return false
	return true


func _build_frames(input: Dictionary) -> Dictionary:
	var path := String(input["resource"])
	var frame_width := int(input["frameWidth"])
	var frame_height := int(input["frameHeight"])
	var frames := SpriteFrames.new()
	frames.remove_animation(&"default")
	var expected := {}
	var textures := {}
	for animation in input["animations"]:
		var name := StringName(animation["name"])
		var texture_path := String(animation["texture"])
		var texture = ResourceLoader.load(texture_path, "Texture2D")
		if not (texture is Texture2D):
			_fail("%s did not load as a texture" % texture_path)
			continue
		var size: Vector2 = texture.get_size()
		if int(size.y) != frame_height or int(size.x) % frame_width != 0 or int(size.x) == 0:
			_fail(
				(
					"%s is %dx%d, not a row of %dx%d frames"
					% [texture_path, size.x, size.y, frame_width, frame_height]
				)
			)
			continue
		var count := int(size.x) / frame_width
		frames.add_animation(name)
		frames.set_animation_speed(name, float(animation["speed"]))
		frames.set_animation_loop(name, bool(animation["loop"]))
		for i in count:
			var region := AtlasTexture.new()
			region.atlas = texture
			region.region = Rect2(i * frame_width, 0, frame_width, frame_height)
			frames.add_frame(name, region, 1.0)
		expected[String(name)] = count
		textures[texture_path] = ResourceUID.id_to_text(ResourceLoader.get_resource_uid(texture_path))
	if not _errors.is_empty():
		return {}
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var saved := ResourceSaver.save(frames, path)
	if saved != OK:
		_fail("ResourceSaver could not save %s: %s" % [path, error_string(saved)])
		return {}
	if not _keep_uid(path, input.get("uid")):
		return {}
	return _reload(path, expected, textures)


## Reloads the saved resource from disk and checks it holds what was built.
func _reload(path: String, expected: Dictionary, textures: Dictionary) -> Dictionary:
	var loaded = ResourceLoader.load(path, "SpriteFrames", ResourceLoader.CACHE_MODE_IGNORE)
	if not (loaded is SpriteFrames):
		_fail("ResourceLoader could not load %s back as SpriteFrames" % path)
		return {}
	var animations := {}
	for name in loaded.get_animation_names():
		var count: int = loaded.get_frame_count(name)
		animations[String(name)] = count
		for i in count:
			var frame = loaded.get_frame_texture(name, i)
			if not (frame is AtlasTexture) or frame.atlas == null:
				_fail("frame %d of %s in %s is not an atlas region" % [i, name, path])
	if animations != expected:
		_fail("%s loaded back with %s, built with %s" % [path, animations, expected])
	return {
		"resource": path,
		"uid": ResourceUID.id_to_text(ResourceLoader.get_resource_uid(path)),
		"animations": animations,
		"textures": textures,
	}


## Builds the TileSet: the existing one loaded, or a new one with one Match Corners terrain set
## (terrain 0 the lower, 1 the upper). Only the atlas source whose texture is the input's atlas
## changes: its texture, region size, tiles and their terrain data. Every other source, terrain
## set, layer and alternative tile stays as it was.
func _build_tile_set(input: Dictionary) -> Dictionary:
	var path := String(input["resource"])
	var texture_path := String(input["texture"])
	var tile_size := int(input["tileSize"])
	var texture = ResourceLoader.load(texture_path, "Texture2D")
	if not (texture is Texture2D):
		_fail("%s did not load as a texture" % texture_path)
		return {}
	var size: Vector2 = texture.get_size()
	if int(size.x) != 4 * tile_size or int(size.y) != 4 * tile_size:
		_fail(
			(
				"%s is %dx%d, not 4 x 4 tiles of %dpx"
				% [texture_path, size.x, size.y, tile_size]
			)
		)
		return {}
	var tile_set: TileSet
	if bool(input.get("existing", false)):
		var existing = ResourceLoader.load(path, "TileSet")
		if not (existing is TileSet):
			_fail("ResourceLoader could not load the existing %s as a TileSet" % path)
			return {}
		tile_set = existing
	else:
		tile_set = TileSet.new()
		tile_set.tile_size = Vector2i(tile_size, tile_size)
	if tile_set.get_terrain_sets_count() == 0:
		var terrains: Dictionary = input["terrains"]
		tile_set.add_terrain_set()
		tile_set.set_terrain_set_mode(0, TileSet.TERRAIN_MODE_MATCH_CORNERS)
		tile_set.add_terrain(0)
		tile_set.set_terrain_name(0, 0, String(terrains["lower"]))
		tile_set.set_terrain_color(0, 0, Color(0.55, 0.4, 0.25))
		tile_set.add_terrain(0)
		tile_set.set_terrain_name(0, 1, String(terrains["upper"]))
		tile_set.set_terrain_color(0, 1, Color(0.35, 0.6, 0.3))
	elif (
		tile_set.get_terrain_set_mode(0) != TileSet.TERRAIN_MODE_MATCH_CORNERS
		or tile_set.get_terrains_count(0) < 2
	):
		_fail(
			(
				"%s's terrain set 0 is not in Match Corners mode with two terrains (0 the lower, 1 the upper)"
				% path
			)
		)
		return {}
	var source_id := _owned_source(tile_set, texture_path)
	var source: TileSetAtlasSource
	if source_id == -1:
		source = TileSetAtlasSource.new()
		source.texture = texture
		source.texture_region_size = Vector2i(tile_size, tile_size)
		source_id = tile_set.add_source(source)
	else:
		source = tile_set.get_source(source_id) as TileSetAtlasSource
		source.texture = texture
		source.texture_region_size = Vector2i(tile_size, tile_size)
	for tile in input["tiles"]:
		var coords := Vector2i(int(tile["coords"][0]), int(tile["coords"][1]))
		if not source.has_tile(coords):
			source.create_tile(coords)
		var data: TileData = source.get_tile_data(coords, 0)
		data.terrain_set = 0
		data.terrain = int(tile["terrain"])
		for corner in CORNERS:
			data.set_terrain_peering_bit(CORNERS[corner], int(tile["peering"][corner]))
	if not _errors.is_empty():
		return {}
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var saved := ResourceSaver.save(tile_set, path)
	if saved != OK:
		_fail("ResourceSaver could not save %s: %s" % [path, error_string(saved)])
		return {}
	if not _keep_uid(path, input.get("uid")):
		return {}
	return _reload_tile_set(path, texture_path, tile_size)


## The id of the atlas source whose texture is `texture_path`, or -1.
func _owned_source(tile_set: TileSet, texture_path: String) -> int:
	for i in tile_set.get_source_count():
		var id := tile_set.get_source_id(i)
		var source = tile_set.get_source(id)
		if (
			source is TileSetAtlasSource
			and source.texture != null
			and source.texture.resource_path == texture_path
		):
			return id
	return -1


## Puts the target's UID back on the saved resource, when it had one.
func _keep_uid(path: String, uid) -> bool:
	if not (uid is String) or uid == "":
		return true
	var id := ResourceUID.text_to_id(uid)
	if id == ResourceUID.INVALID_ID:
		_fail("the resource's UID %s is not a UID" % uid)
		return false
	var kept := ResourceSaver.set_uid(path, id)
	if kept != OK:
		_fail("ResourceSaver could not keep the UID %s on %s: %s" % [uid, path, error_string(kept)])
		return false
	return true


## The hand-off check: reloads the saved TileSet from disk and reads every tile's terrain data
## back against the corner-16 layout, which it computes from the tile's index, not the input.
func _reload_tile_set(path: String, texture_path: String, tile_size: int) -> Dictionary:
	var loaded = ResourceLoader.load(path, "TileSet", ResourceLoader.CACHE_MODE_IGNORE)
	if not (loaded is TileSet):
		_fail("ResourceLoader could not load %s back as a TileSet" % path)
		return {}
	var source_id := _owned_source(loaded, texture_path)
	if source_id == -1:
		_fail("%s loaded back with no atlas source of %s" % [path, texture_path])
		return {}
	var source := loaded.get_source(source_id) as TileSetAtlasSource
	if source.texture_region_size != Vector2i(tile_size, tile_size):
		_fail(
			(
				"%s's atlas source loaded back with region size %s, not %dpx"
				% [path, source.texture_region_size, tile_size]
			)
		)
	if loaded.get_terrain_set_mode(0) != TileSet.TERRAIN_MODE_MATCH_CORNERS:
		_fail("%s's terrain set 0 loaded back not in Match Corners mode" % path)
	var tiles := 0
	for index in 16:
		var coords := Vector2i(index % 4, index / 4)
		if not source.has_tile(coords):
			_fail("%s loaded back without tile %d at %s" % [path, index, coords])
			continue
		var data: TileData = source.get_tile_data(coords, 0)
		var centre := 1 if index == 15 else 0
		if data.terrain_set != 0 or data.terrain != centre:
			_fail(
				(
					"tile %d of %s loaded back with terrain set %d, terrain %d; the layout gives 0, %d"
					% [index, path, data.terrain_set, data.terrain, centre]
				)
			)
		for corner in CORNERS:
			var want := 1 if (index & int(CORNER_BITS[corner])) != 0 else 0
			var got := data.get_terrain_peering_bit(CORNERS[corner])
			if got != want:
				_fail(
					(
						"tile %d of %s loaded back with its %s peering bit %d; the layout gives %d"
						% [index, path, corner, got, want]
					)
				)
		tiles += 1
	return {
		"resource": path,
		"uid": ResourceUID.id_to_text(ResourceLoader.get_resource_uid(path)),
		"source": source_id,
		"tiles": tiles,
	}
