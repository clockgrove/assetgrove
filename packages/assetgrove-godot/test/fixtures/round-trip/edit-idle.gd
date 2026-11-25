# The developer retimes the handed-off idle animation, so a later hand-off of idle would overwrite it.
extends SceneTree


func _init() -> void:
	var path := "res://characters/fern.tres"
	var frames := load(path) as SpriteFrames
	frames.set_animation_speed(&"idle", 3.0)
	var uid := ResourceLoader.get_resource_uid(path)
	# Outside the editor the text saver drops the header's uid; the editor keeps it, so put it back.
	if ResourceSaver.save(frames, path) != OK or (
		uid != ResourceUID.INVALID_ID and ResourceSaver.set_uid(path, uid) != OK
	):
		push_error("could not save the SpriteFrames")
		quit(1)
		return
	print("EDITED")
	quit()
