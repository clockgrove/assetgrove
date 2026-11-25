# The review dock: the local runs and their candidates in a list, one candidate's provenance, QA
# reasons and review state, and accept, reject and regenerate buttons. Each button opens a
# confirmation dialog that shows the command it would run; OK runs the developer's `assetgrove`
# command on a thread, Cancel runs nothing. When the command needs the developer's own
# confirmation it exits 8 and the dock shows the command to confirm at a terminal; the dock never
# confirms or approves anything itself. Every text from a record is shown as plain text.
@tool
extends VBoxContainer

const ReviewStore = preload("review_store.gd")
const ReviewActions = preload("review_actions.gd")

signal action_finished(result: Dictionary)

var store = null
var actions = null
var last_result: Dictionary = {}
var current: Dictionary = {}
var runs: Array = []
var pending_argv: PackedStringArray = []

var _list: ItemList
var _state_label: Label
var _preview: TextureRect
var _details: TextEdit
var _accept_button: Button
var _reject_button: Button
var _regenerate_button: Button
var _reason_edit: LineEdit
var _status_label: Label
var _copy_button: Button
var _dialog: ConfirmationDialog
var _thread: Thread = null
var _confirm_command: String = ""


func _init() -> void:
	name = "AssetgroveReview"

	var refresh_button := Button.new()
	refresh_button.text = "Refresh"
	refresh_button.pressed.connect(refresh)
	add_child(refresh_button)

	_list = ItemList.new()
	_list.custom_minimum_size = Vector2(0, 120)
	_list.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_list.item_selected.connect(_on_item_selected)
	add_child(_list)

	_state_label = Label.new()
	_state_label.text = "Review state: "
	add_child(_state_label)

	_preview = TextureRect.new()
	_preview.custom_minimum_size = Vector2(0, 128)
	_preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_preview.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	add_child(_preview)

	_details = TextEdit.new()
	_details.editable = false
	_details.wrap_mode = TextEdit.LINE_WRAPPING_BOUNDARY
	_details.custom_minimum_size = Vector2(0, 160)
	_details.size_flags_vertical = Control.SIZE_EXPAND_FILL
	add_child(_details)

	_reason_edit = LineEdit.new()
	_reason_edit.placeholder_text = "Reason for rejecting"
	add_child(_reason_edit)

	var row := HBoxContainer.new()
	_accept_button = Button.new()
	_accept_button.text = "Accept"
	_accept_button.pressed.connect(request_accept)
	row.add_child(_accept_button)
	_reject_button = Button.new()
	_reject_button.text = "Reject"
	_reject_button.pressed.connect(_on_reject_pressed)
	row.add_child(_reject_button)
	_regenerate_button = Button.new()
	_regenerate_button.text = "Regenerate"
	_regenerate_button.pressed.connect(request_regenerate)
	row.add_child(_regenerate_button)
	add_child(row)

	_status_label = Label.new()
	_status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	add_child(_status_label)

	_copy_button = Button.new()
	_copy_button.text = "Copy"
	_copy_button.visible = false
	_copy_button.pressed.connect(_on_copy_pressed)
	add_child(_copy_button)

	_dialog = ConfirmationDialog.new()
	_dialog.title = "Assetgrove review"
	_dialog.visible = false
	_dialog.confirmed.connect(confirm_pending)
	_dialog.canceled.connect(cancel_pending)
	add_child(_dialog)

	_update_buttons()


func _exit_tree() -> void:
	if _thread != null and _thread.is_started():
		_thread.wait_to_finish()
	_thread = null


func configure(target_dir: String, command: PackedStringArray) -> void:
	store = ReviewStore.new(target_dir.path_join(".assetgrove/runs"))
	actions = ReviewActions.new(command, target_dir)
	refresh()


func refresh() -> void:
	if store == null:
		return
	runs = store.list_runs()
	_list.clear()
	for run in runs:
		for candidate_id in run["candidates"]:
			var index := _list.add_item("%s %s %s" % [run["assetId"], run["id"], candidate_id])
			_list.set_item_metadata(index, {"run": run["id"], "id": candidate_id})
	if not current.is_empty():
		select(String(current.get("run", "")), String(current.get("id", "")))
	else:
		_update_buttons()


func select(run_id: String, candidate_id: String) -> bool:
	if store == null:
		return false
	var loaded: Dictionary = store.load_candidate(run_id, candidate_id)
	if loaded.is_empty():
		current = {}
		_state_label.text = "Review state: "
		_preview.texture = null
		_details.text = ""
		_update_buttons()
		return false
	current = loaded
	_state_label.text = "Review state: " + review_state()
	_preview.texture = store.preview(current)
	_details.text = store.provenance_text(current)
	for index in range(_list.item_count):
		var meta = _list.get_item_metadata(index)
		if meta is Dictionary and meta["run"] == run_id and meta["id"] == candidate_id:
			_list.select(index)
			break
	_update_buttons()
	return true


func review_state() -> String:
	var review = current.get("review")
	if review is Dictionary:
		return String(review.get("status", ""))
	return ""


func details_text() -> String:
	return _details.text


func has_preview() -> bool:
	return _preview.texture != null


func is_busy() -> bool:
	return _thread != null


func request_accept() -> void:
	if not _can_request():
		return
	_ask(actions.accept_argv(String(current["run_dir"]), String(current["id"])))


func request_reject(reason: String) -> void:
	if not _can_request():
		return
	if reason.strip_edges() == "":
		_set_status("Give a reason to reject.")
		return
	_ask(actions.reject_argv(String(current["run_dir"]), String(current["id"]), reason))


func request_regenerate() -> void:
	if not _can_request():
		return
	_ask(actions.regenerate_argv(String(current["run_dir"]), String(current["id"])))


## What the dialog's confirmed signal calls: runs the pending command on a thread.
func confirm_pending() -> void:
	if pending_argv.is_empty() or is_busy():
		return
	var argv := pending_argv
	pending_argv = PackedStringArray()
	_set_status("Running: " + " ".join(argv))
	_thread = Thread.new()
	_thread.start(_run_argv.bind(argv))
	_update_buttons()


## What the dialog's canceled signal calls: runs nothing and leaves the records unchanged.
func cancel_pending() -> void:
	pending_argv = PackedStringArray()
	last_result = {"outcome": "cancelled"}
	_set_status("Cancelled: nothing ran")


func _run_argv(argv: PackedStringArray) -> void:
	var result = actions.run(argv)
	_finish.call_deferred(result)


func _finish(result: Dictionary) -> void:
	if _thread != null:
		_thread.wait_to_finish()
		_thread = null
	last_result = result
	var outcome := String(result.get("outcome", ""))
	if outcome == "confirm":
		var command := String(result.get("confirmCommand", ""))
		var text := "Confirm it at a terminal: %s, then press Refresh" % command
		var summary := String(result.get("summary", ""))
		if summary != "":
			text = summary + "\n" + text
		_set_status(text, command)
	elif outcome == "done":
		_set_status("Done: " + String(result.get("message", "")))
	elif outcome == "declined":
		_set_status("Declined: " + String(result.get("message", "")))
	else:
		_set_status("Failed: " + String(result.get("message", "")))
	refresh()
	action_finished.emit(result)


func _ask(argv: PackedStringArray) -> void:
	pending_argv = argv
	_dialog.dialog_text = "Run this command?\n" + " ".join(argv)
	_set_status("Waiting for your confirmation.")
	if is_inside_tree():
		_dialog.popup_centered()


func _can_request() -> bool:
	if actions == null or not actions.available():
		_set_status("The assetgrove command is not set.")
		return false
	if current.is_empty():
		_set_status("Select a candidate first.")
		return false
	if is_busy():
		_set_status("A command is still running.")
		return false
	return true


func _set_status(text: String, confirm_command: String = "") -> void:
	_status_label.text = text
	_confirm_command = confirm_command
	_copy_button.visible = confirm_command != ""


func _update_buttons() -> void:
	var enabled: bool = actions != null and actions.available() and not current.is_empty() and not is_busy()
	_accept_button.disabled = not enabled
	_reject_button.disabled = not enabled
	_regenerate_button.disabled = not enabled


func _on_item_selected(index: int) -> void:
	var meta = _list.get_item_metadata(index)
	if meta is Dictionary:
		select(String(meta["run"]), String(meta["id"]))


func _on_reject_pressed() -> void:
	request_reject(_reason_edit.text)


func _on_copy_pressed() -> void:
	DisplayServer.clipboard_set(_confirm_command)
