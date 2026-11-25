# The Godot pack's build script (@clockgrove/assetgrove-godot): an editor plugin of the scratch
# project the pack lays out for one hand-off. Godot's headless editor imports the media; this
# script first checks that it runs on the Godot release the input names (the pinned 4.7.2-stable),
# then builds the resource the input asks for through Godot's API from the input the pack wrote as
# data: a SpriteFrames (godot:sprite-frames), or a TileSet (godot:tile-set, `"build": "tile-set"`);
# or, for a glTF scene (godot:gltf, `"build": "gltf"`), it applies a fresh source's import options,
# reimports it and checks the imported scene against what the asset declares. For a SpriteFrames
# or a TileSet it first applies the input's import options to the `.import` of each fresh source
# (one the target had no `.import` for), reimports them and checks the options held.
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
## The metadata key of the SpriteFrames record of what the preset wrote.
const META := &"assetgrove_godot"
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
		var build := String(input.get("build", ""))
		if _errors.is_empty() and build != "gltf":
			await _apply_import_options(input.get("fresh", []), input.get("options", {}))
		if _errors.is_empty():
			if build == "tile-set":
				result = _build_tile_set(input)
			elif build == "gltf":
				result = await _import_gltf(input)
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
	elif input.has("scene"):
		paths.append(String(input["scene"]))
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


## Builds the SpriteFrames. A new one has one animation per input family. An existing one is
## loaded and merged into: only the animations named after the input's families are replaced, and
## only when the developer has not changed them since the preset wrote them (`_conflicts`); every
## other animation, property and metadata key stays as it was. The preset records what it wrote in
## the resource's `assetgrove_godot` metadata.
func _build_frames(input: Dictionary) -> Dictionary:
	var path := String(input["resource"])
	var frame_width := int(input["frameWidth"])
	var frame_height := int(input["frameHeight"])
	var frames: SpriteFrames
	if bool(input.get("existing", false)):
		var existing = ResourceLoader.load(path, "SpriteFrames", ResourceLoader.CACHE_MODE_IGNORE)
		if not (existing is SpriteFrames):
			_fail("ResourceLoader could not load the existing %s as SpriteFrames" % path)
			return {}
		frames = existing
	else:
		frames = SpriteFrames.new()
		frames.remove_animation(&"default")
	var record := _record(frames)
	var conflicts := _conflicts(
		path, frames, record, input["animations"], frame_width, frame_height
	)
	if not conflicts.is_empty():
		_errors.append_array(conflicts)
		return {"conflicts": Array(conflicts)}
	# Families not in this hand-off keep what the preset last wrote for them.
	var written := {}
	var kept = record.get("animations", {})
	if kept is Dictionary:
		written = (kept as Dictionary).duplicate(true)
	var families := []
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
		if frames.has_animation(name):
			frames.remove_animation(name)
		frames.add_animation(name)
		frames.set_animation_speed(name, float(animation["speed"]))
		frames.set_animation_loop(name, bool(animation["loop"]))
		for i in count:
			var region := AtlasTexture.new()
			region.atlas = texture
			region.region = Rect2(i * frame_width, 0, frame_width, frame_height)
			frames.add_frame(name, region, 1.0)
		families.append(String(name))
		written[String(name)] = {
			"texture": texture_path,
			"frames": count,
			"width": frame_width,
			"height": frame_height,
			"speed": float(animation["speed"]),
			"loop": bool(animation["loop"]),
		}
		textures[texture_path] = ResourceUID.id_to_text(ResourceLoader.get_resource_uid(texture_path))
	if not _errors.is_empty():
		return {}
	record["animations"] = written
	frames.set_meta(META, record)
	var expected := {}
	for name in frames.get_animation_names():
		expected[String(name)] = frames.get_frame_count(name)
	DirAccess.make_dir_recursive_absolute(path.get_base_dir())
	var saved := ResourceSaver.save(frames, path)
	if saved != OK:
		_fail("ResourceSaver could not save %s: %s" % [path, error_string(saved)])
		return {}
	if not _keep_uid(path, input.get("uid")):
		return {}
	return _reload(path, expected, families, textures)


## The preset's record in the resource's metadata, a copy; keys other than `animations` are the
## developer's and stay.
func _record(frames: SpriteFrames) -> Dictionary:
	var meta = frames.get_meta(META, {})
	if meta is Dictionary:
		return (meta as Dictionary).duplicate()
	return {}


## What differs between the input's family animations that `frames` already has and what the
## preset last wrote: its record's entry, or for a resource from before the record, the preset's
## own shape (the input's texture, the animation's current frame count, the input's frame size,
## speed and loop). One sentence each, its numbers written by `_number`.
func _conflicts(
	path: String,
	frames: SpriteFrames,
	record: Dictionary,
	animations: Array,
	frame_width: int,
	frame_height: int
) -> PackedStringArray:
	var conflicts := PackedStringArray()
	var written = record.get("animations", {})
	if not (written is Dictionary):
		written = {}
	for animation in animations:
		var name := StringName(animation["name"])
		if not frames.has_animation(name):
			continue
		var wrote = written.get(String(name), {})
		if not (wrote is Dictionary):
			wrote = {}
		var texture_path := String(wrote.get("texture", animation["texture"]))
		var count := int(wrote.get("frames", frames.get_frame_count(name)))
		var width := int(wrote.get("width", frame_width))
		var height := int(wrote.get("height", frame_height))
		var speed := float(wrote.get("speed", animation["speed"]))
		var loops := bool(wrote.get("loop", animation["loop"]))
		var where := path.trim_prefix("res://")
		var now_speed := frames.get_animation_speed(name)
		if not is_equal_approx(now_speed, speed):
			conflicts.append(
				'animation "%s": speed is %s in %s, the preset wrote %s'
				% [name, _number(now_speed), where, _number(speed)]
			)
		if frames.get_animation_loop(name) != loops:
			conflicts.append(
				'animation "%s": loop is %s in %s, the preset wrote %s'
				% [name, frames.get_animation_loop(name), where, loops]
			)
		if frames.get_frame_count(name) != count:
			conflicts.append(
				'animation "%s": it has %d frames in %s, the preset wrote %d'
				% [name, frames.get_frame_count(name), where, count]
			)
			continue
		for i in count:
			var problem := _frame_problem(frames, name, i, texture_path, width, height)
			if problem != "":
				conflicts.append('animation "%s": frame %d %s in %s' % [name, i, problem, where])
				break
	return conflicts


## What is not as the preset wrote it in frame `index` of `name`, or "" when it is as written.
func _frame_problem(
	frames: SpriteFrames,
	name: StringName,
	index: int,
	texture_path: String,
	frame_width: int,
	frame_height: int
) -> String:
	var frame = frames.get_frame_texture(name, index)
	if not (frame is AtlasTexture):
		return "is not an atlas region"
	if frame.atlas == null or frame.atlas.resource_path != texture_path:
		return "is not a region of %s" % texture_path
	var region := Rect2(index * frame_width, 0, frame_width, frame_height)
	if frame.region != region:
		return "is the region %s, the preset wrote %s" % [_rect(frame.region), _rect(region)]
	if not is_equal_approx(frames.get_frame_duration(name, index), 1.0):
		return "has duration %s, the preset wrote 1" % _number(frames.get_frame_duration(name, index))
	return ""


## `value` as a conflict sentence writes it, the same in every Godot version: a whole number
## without a decimal (`3`), any other with up to three decimals and no trailing zeros (`2.5`).
func _number(value: float) -> String:
	if is_equal_approx(value, roundf(value)):
		return "%d" % int(roundf(value))
	return String.num(value, 3)


## `rect` as a conflict sentence writes it: `x,y wxh` in `_number`s.
func _rect(rect: Rect2) -> String:
	return (
		"%s,%s %sx%s"
		% [_number(rect.position.x), _number(rect.position.y), _number(rect.size.x), _number(rect.size.y)]
	)


## Reloads the saved resource from disk and checks it holds what was built: every animation with
## its frame count, and each family animation's frames as atlas regions. A developer's animation
## may hold any texture.
func _reload(path: String, expected: Dictionary, families: Array, textures: Dictionary) -> Dictionary:
	var loaded = ResourceLoader.load(path, "SpriteFrames", ResourceLoader.CACHE_MODE_IGNORE)
	if not (loaded is SpriteFrames):
		_fail("ResourceLoader could not load %s back as SpriteFrames" % path)
		return {}
	var animations := {}
	for name in loaded.get_animation_names():
		var count: int = loaded.get_frame_count(name)
		animations[String(name)] = count
		if not families.has(String(name)):
			continue
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
## changes: its texture, region size, tiles and their terrain data, on the terrain set
## `_preset_terrain_set` picks. Every other source, terrain set, layer and alternative tile stays
## as it was.
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
	var source_id := _owned_source(tile_set, texture_path)
	var terrain_set := _preset_terrain_set(tile_set, source_id, input["terrains"])
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
		data.terrain_set = terrain_set
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
	return _reload_tile_set(path, texture_path, tile_size, terrain_set)


## The terrain set the preset's tiles use, terrain 0 the lower and 1 the upper: the Match Corners
## set the owned source's tile 0 already uses (an earlier hand-off's), else a Match Corners set
## whose terrains 0 and 1 are named after the lower and upper terrains, else a new set of the
## preset's own added after every other. A developer's terrain sets are never changed or reused
## for unrelated terrains, and a new TileSet's set is set 0.
func _preset_terrain_set(tile_set: TileSet, source_id: int, terrains: Dictionary) -> int:
	var lower := String(terrains["lower"])
	var upper := String(terrains["upper"])
	if source_id != -1:
		var source := tile_set.get_source(source_id) as TileSetAtlasSource
		if source.has_tile(Vector2i(0, 0)):
			var used := source.get_tile_data(Vector2i(0, 0), 0).terrain_set
			if _corner_set(tile_set, used):
				return used
	for index in tile_set.get_terrain_sets_count():
		if (
			_corner_set(tile_set, index)
			and tile_set.get_terrain_name(index, 0) == lower
			and tile_set.get_terrain_name(index, 1) == upper
		):
			return index
	var added := tile_set.get_terrain_sets_count()
	tile_set.add_terrain_set()
	tile_set.set_terrain_set_mode(added, TileSet.TERRAIN_MODE_MATCH_CORNERS)
	tile_set.add_terrain(added)
	tile_set.set_terrain_name(added, 0, lower)
	tile_set.set_terrain_color(added, 0, Color(0.55, 0.4, 0.25))
	tile_set.add_terrain(added)
	tile_set.set_terrain_name(added, 1, upper)
	tile_set.set_terrain_color(added, 1, Color(0.35, 0.6, 0.3))
	return added


## Whether terrain set `index` exists, is in Match Corners mode and has at least two terrains.
func _corner_set(tile_set: TileSet, index: int) -> bool:
	return (
		index >= 0
		and index < tile_set.get_terrain_sets_count()
		and tile_set.get_terrain_set_mode(index) == TileSet.TERRAIN_MODE_MATCH_CORNERS
		and tile_set.get_terrains_count(index) >= 2
	)


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
func _reload_tile_set(
	path: String, texture_path: String, tile_size: int, terrain_set: int
) -> Dictionary:
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
	if not _corner_set(loaded, terrain_set):
		_fail(
			(
				"%s's terrain set %d loaded back not in Match Corners mode with two terrains"
				% [path, terrain_set]
			)
		)
	var tiles := 0
	for index in 16:
		var coords := Vector2i(index % 4, index / 4)
		if not source.has_tile(coords):
			_fail("%s loaded back without tile %d at %s" % [path, index, coords])
			continue
		var data: TileData = source.get_tile_data(coords, 0)
		var centre := 1 if index == 15 else 0
		if data.terrain_set != terrain_set or data.terrain != centre:
			_fail(
				(
					"tile %d of %s loaded back with terrain set %d, terrain %d; the layout gives %d, %d"
					% [index, path, data.terrain_set, data.terrain, terrain_set, centre]
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
		"terrainSet": terrain_set,
		"tiles": tiles,
	}


## Imports a glTF scene (godot:gltf): a fresh source's import options go into its `.import` and
## it is reimported; then the imported scene is loaded, instantiated and checked against what the
## asset declares (every animation by name, a Skeleton3D of the joint count, no more meshes).
func _import_gltf(input: Dictionary) -> Dictionary:
	var path := String(input["scene"])
	var options: Dictionary = input.get("options", {})
	if bool(input.get("fresh", false)):
		await _apply_import_options([path], options)
		if not _errors.is_empty():
			return {}
	var declared := _declared(path, input.get("declared", {}))
	if not _errors.is_empty():
		return {}
	var packed = ResourceLoader.load(path, "PackedScene", ResourceLoader.CACHE_MODE_IGNORE)
	if not (packed is PackedScene):
		_fail("%s did not load as a scene" % path)
		return {}
	var scene: Node = packed.instantiate()
	if scene == null:
		_fail("%s did not instantiate" % path)
		return {}
	var animations: Array = []
	var skeletons: Array = []
	var meshes := 0
	var nodes: Array[Node] = [scene]
	while not nodes.is_empty():
		var node: Node = nodes.pop_back()
		if node is AnimationPlayer:
			for name in node.get_animation_list():
				animations.append(String(name))
		elif node is Skeleton3D:
			skeletons.append(node.get_bone_count())
		elif node is MeshInstance3D:
			meshes += 1
		nodes.append_array(node.get_children(true))
	scene.free()
	for name in declared["animations"]:
		if not animations.has(name):
			_fail("%s imported without the animation %s (it has %s)" % [path, name, animations])
	# An unskinned scene declares no joints and needs no Skeleton3D.
	if int(declared["joints"]) > 0 and not skeletons.has(declared["joints"]):
		_fail(
			(
				"%s imported without a Skeleton3D of %d joints (its skeletons have %s bones)"
				% [path, declared["joints"], skeletons]
			)
		)
	if meshes > int(declared["meshes"]):
		_fail(
			(
				"%s imported with %d meshes, more than the %d it declares"
				% [path, meshes, declared["meshes"]]
			)
		)
	return {
		"resource": path,
		"uid": ResourceUID.id_to_text(ResourceLoader.get_resource_uid(path)),
		"declared": declared,
		"imported": {"animations": animations, "skeletons": skeletons, "meshes": meshes},
	}


## Applies import options to the `.import` of each path (a fresh source): they are written into
## its `[params]`, all the paths are reimported at once, and each value is read back. Nothing
## happens without options or paths. An existing `.import` is never a path here.
func _apply_import_options(paths: Array, options: Dictionary) -> void:
	if paths.is_empty() or options.is_empty():
		return
	for path in paths:
		var config := ConfigFile.new()
		var loaded := config.load(String(path) + ".import")
		if loaded != OK:
			_fail("cannot read %s.import: %s" % [path, error_string(loaded)])
			return
		for key in options:
			config.set_value("params", String(key), _option_value(options[key]))
		var saved := config.save(String(path) + ".import")
		if saved != OK:
			_fail("cannot write %s.import: %s" % [path, error_string(saved)])
			return
	EditorInterface.get_resource_filesystem().reimport_files(PackedStringArray(paths))
	await get_tree().process_frame
	for path in paths:
		var params := ConfigFile.new()
		params.load(String(path) + ".import")
		for key in options:
			var got = params.get_value("params", String(key), null)
			if got != _option_value(options[key]):
				_fail(
					(
						"%s.import holds %s = %s after the reimport, not %s"
						% [path, key, var_to_str(got), var_to_str(_option_value(options[key]))]
					)
				)


## An import option's value from the input's JSON: a whole number is an int, as Godot's own.
func _option_value(value):
	if typeof(value) == TYPE_FLOAT and value == floor(value):
		return int(value)
	return value


## What the asset declares: each fact the input gives, else the file's own, read through
## GLTFDocument: its animation names, the unique joints over every skin, and the nodes with a
## mesh reachable from its scene's roots.
func _declared(path: String, given: Dictionary) -> Dictionary:
	var declared := {}
	var state := GLTFState.new()
	var parsed := GLTFDocument.new().append_from_file(path, state)
	if parsed != OK:
		_fail("GLTFDocument could not read %s: %s" % [path, error_string(parsed)])
		return {}
	if given.has("animations"):
		declared["animations"] = given["animations"].map(func(n): return String(n))
	else:
		declared["animations"] = state.get_animations().map(func(a): return String(a.original_name))
	if given.has("joints"):
		declared["joints"] = int(given["joints"])
	else:
		var joints := {}
		for skin in state.get_skins():
			for joint in skin.joints_original:
				joints[joint] = true
		declared["joints"] = joints.size()
	if given.has("meshes"):
		declared["meshes"] = int(given["meshes"])
	else:
		var gltf_nodes := state.get_nodes()
		var meshes := 0
		var pending: Array = Array(state.root_nodes)
		while not pending.is_empty():
			var node: GLTFNode = gltf_nodes[int(pending.pop_back())]
			if node.mesh >= 0:
				meshes += 1
			pending.append_array(Array(node.children))
		declared["meshes"] = meshes
	return declared
