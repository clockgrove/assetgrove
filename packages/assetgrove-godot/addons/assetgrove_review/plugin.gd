# The Assetgrove review dock as an optional editor plugin. It adds one dock that reads the
# candidates under `<target>/.assetgrove/runs` and runs the developer's own `assetgrove` command
# for accept, reject and regenerate; it never confirms or approves anything itself.
#
# Settings: the editor setting `assetgrove/review/command` (the argv prefix, default ["assetgrove"])
# and the optional project setting `assetgrove/review/target` (default: the project folder).
@tool
extends EditorPlugin

const ReviewDock = preload("review_dock.gd")
const COMMAND_KEY := "assetgrove/review/command"

var dock = null


func _enter_tree() -> void:
	dock = ReviewDock.new()
	dock.configure(_target(), _command())
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, dock)


func _exit_tree() -> void:
	if dock == null:
		return
	remove_control_from_docks(dock)
	dock.queue_free()
	dock = null


func _command() -> PackedStringArray:
	var settings := EditorInterface.get_editor_settings()
	var fallback := PackedStringArray(["assetgrove"])
	if not settings.has_setting(COMMAND_KEY):
		settings.set_setting(COMMAND_KEY, fallback)
		settings.set_initial_value(COMMAND_KEY, fallback, false)
		settings.add_property_info({"name": COMMAND_KEY, "type": TYPE_PACKED_STRING_ARRAY})
	var value = settings.get_setting(COMMAND_KEY)
	if value is PackedStringArray:
		return value
	if value is Array:
		return PackedStringArray(value)
	return fallback


func _target() -> String:
	var configured := String(ProjectSettings.get_setting("assetgrove/review/target", "res://"))
	var path := ProjectSettings.globalize_path(configured).simplify_path()
	while path.length() > 1 and path.ends_with("/"):
		path = path.substr(0, path.length() - 1)
	return path
