# The developer retimes the handed-off idle animation, so a later hand-off of idle would overwrite it.
extends SceneTree


func _init() -> void:
	var path := "res://characters/fern.tres"
	var frames := load(path) as SpriteFrames
	frames.set_animation_speed(&"idle", 3.0)
	if ResourceSaver.save(frames, path) != OK:
		push_error("could not save the SpriteFrames")
		quit(1)
		return
	print("EDITED")
	quit()
