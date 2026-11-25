@tool
extends EditorPlugin
## Drives the Assetgrove review dock from res://.review-test/input.json, writes what it saw to
## res://.review-test/result.json and quits the editor.

const INPUT := "res://.review-test/input.json"
const RESULT := "res://.review-test/result.json"
const TIMEOUT_SECONDS := 120.0

var _finished := false


func _enter_tree() -> void:
	get_tree().create_timer(TIMEOUT_SECONDS).timeout.connect(_on_timeout)
	_run.call_deferred()


func _on_timeout() -> void:
	_finish({"error": "timed out"}, 1)


func _finish(result: Dictionary, code: int) -> void:
	if _finished:
		return
	_finished = true
	var file := FileAccess.open(RESULT, FileAccess.WRITE)
	if file != null:
		file.store_string(JSON.stringify(result))
		file.close()
	get_tree().quit(code)


func _read_input() -> Dictionary:
	var text := FileAccess.get_file_as_string(INPUT)
	var parsed = JSON.parse_string(text)
	if parsed is Dictionary:
		return parsed
	return {}


func _run() -> void:
	for i in 3:
		await get_tree().process_frame
	var input := _read_input()
	var dock = EditorInterface.get_base_control().find_child("AssetgroveReview", true, false)
	if dock == null:
		_finish({"dockFound": false}, 1)
		return
	var result := {"dockFound": true}
	var command := PackedStringArray()
	for part in input.get("command", []):
		command.append(str(part))
	dock.configure(str(input.get("target", "")), command)
	var run_id := str(input.get("run", ""))
	var candidate := str(input.get("candidate", ""))
	var selected: bool = dock.select(run_id, candidate)
	result["selected"] = selected
	match str(input.get("phase", "")):
		"inspect":
			result["state"] = dock.review_state()
			result["details"] = dock.details_text()
			result["hasPreview"] = dock.has_preview()
			result["runs"] = dock.runs
			dock.request_accept()
			dock.cancel_pending()
			dock.request_reject("not this one")
			dock.cancel_pending()
			dock.request_regenerate()
			dock.cancel_pending()
			result["ran"] = dock.actions.ran.size()
			result["lastOutcome"] = dock.last_result.get("outcome")
			result["opened"] = Array(dock.store.opened)
		"act":
			var action := str(input.get("action", ""))
			if action == "accept":
				dock.request_accept()
			elif action == "reject":
				dock.request_reject(str(input.get("reason", "")))
			elif action == "regenerate":
				dock.request_regenerate()
			dock.confirm_pending()
			var finished = await dock.action_finished
			result["result"] = finished
			result["state"] = dock.review_state()
			var ids := []
			for run in dock.runs:
				ids.append(run.get("id"))
			result["runIds"] = ids
			result["opened"] = Array(dock.store.opened)
		"state":
			result["state"] = dock.review_state()
			result["details"] = dock.details_text()
	_finish(result, 0)
