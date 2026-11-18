# The Godot pack's build script (@clockgrove/assetgrove-godot): an editor plugin of the scratch
# project the pack lays out for one hand-off. Godot's headless editor imports the media; this
# script first checks that it runs on the Godot release the input names (the pinned 4.7.2-stable),
# then builds the SpriteFrames through Godot's API from the input the pack wrote as data,
# saves it with ResourceSaver (keeping the target's UID when it had one), reloads it with
# ResourceLoader and checks what came back. It writes `.assetgrove-godot/result.json` and quits:
# 0 when everything held, 1 otherwise. Every failure is also printed as an ERROR line, which the
# pack treats as a failed run whatever the exit code.
@tool
extends EditorPlugin

const INPUT := "res://.assetgrove-godot/input.json"
const RESULT := "res://.assetgrove-godot/result.json"
## How long the editor may take to import the media before the run gives up.
const IMPORT_TIMEOUT_MS := 240000

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


## Waits until the editor's file system has scanned and imported every animation's texture.
func _wait_for_import(input: Dictionary) -> void:
	var fs := EditorInterface.get_resource_filesystem()
	var started := Time.get_ticks_msec()
	while true:
		var pending := fs.is_scanning()
		for animation in input["animations"]:
			if not FileAccess.file_exists(String(animation["texture"]) + ".import"):
				pending = true
		if not pending:
			return
		if Time.get_ticks_msec() - started > IMPORT_TIMEOUT_MS:
			_fail("the editor did not import the media in time")
			return
		await get_tree().process_frame


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
	var uid = input.get("uid")
	if uid is String and uid != "":
		var id := ResourceUID.text_to_id(uid)
		if id == ResourceUID.INVALID_ID:
			_fail("the resource's UID %s is not a UID" % uid)
			return {}
		var kept := ResourceSaver.set_uid(path, id)
		if kept != OK:
			_fail("ResourceSaver could not keep the UID %s on %s: %s" % [uid, path, error_string(kept)])
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
