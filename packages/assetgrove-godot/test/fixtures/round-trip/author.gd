# What a developer does in the editor after a first hand-off, done headlessly so a test can repeat
# it: adds an animation of their own to the handed-off SpriteFrames and builds a scene that uses it.
extends SceneTree


func _init() -> void:
	var frames_path := "res://characters/fern.tres"
	var frames := load(frames_path) as SpriteFrames
	var hurt := load("res://art/hurt.png") as Texture2D
	frames.add_animation(&"hurt")
	frames.set_animation_speed(&"hurt", 6.0)
	frames.set_animation_loop(&"hurt", false)
	frames.add_frame(&"hurt", hurt)
	frames.add_frame(&"hurt", hurt)
	if ResourceSaver.save(frames, frames_path) != OK:
		push_error("could not save the SpriteFrames")
		quit(1)
		return

	var root := Node2D.new()
	root.name = "Player"
	var sprite := AnimatedSprite2D.new()
	sprite.name = "Sprite"
	sprite.sprite_frames = frames
	sprite.animation = &"idle"
	root.add_child(sprite)
	sprite.owner = root

	var blink := Animation.new()
	blink.length = 0.5
	var track := blink.add_track(Animation.TYPE_VALUE)
	blink.track_set_path(track, NodePath("Sprite:modulate"))
	blink.track_insert_key(track, 0.0, Color(1, 1, 1, 1))
	blink.track_insert_key(track, 0.5, Color(1, 1, 1, 0.5))
	var library := AnimationLibrary.new()
	library.add_animation(&"blink", blink)
	var animator := AnimationPlayer.new()
	animator.name = "Animator"
	animator.add_animation_library(&"", library)
	root.add_child(animator)
	animator.owner = root

	var scene := PackedScene.new()
	if scene.pack(root) != OK:
		push_error("could not pack the scene")
		quit(1)
		return
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path("res://scenes"))
	if ResourceSaver.save(scene, "res://scenes/player.tscn") != OK:
		push_error("could not save the scene")
		quit(1)
		return
	root.free()
	print("AUTHORED")
	quit()
