# Runs the developer's `assetgrove` command for the dock's three actions. It builds the argv, runs
# it and sorts the answer: done, confirmation needed (exit 8 with the command to confirm at a
# terminal), declined, or an error. It never confirms or approves anything on its own.
@tool
extends RefCounted

## The argv prefix, for example ["assetgrove"] or ["node", "/abs/shim.mjs"].
var command: PackedStringArray = []
## The absolute target dir: the Git work tree whose .assetgrove/ holds the runs.
var target: String = ""
## Every argv this object executed, in order.
var ran: Array = []


func _init(cmd: PackedStringArray, target_dir: String) -> void:
	command = cmd
	target = target_dir


func available() -> bool:
	return not command.is_empty() and command[0] != ""


func runs_dir() -> String:
	return target.path_join(".assetgrove/runs")


func accept_argv(run_dir: String, candidate: String) -> PackedStringArray:
	return command + PackedStringArray(["pick", "--run", run_dir, "--candidate", candidate, "--target", target, "--json"])


func reject_argv(run_dir: String, candidate: String, reason: String) -> PackedStringArray:
	return command + PackedStringArray(["review", run_dir, "--candidate", candidate, "--reject", reason, "--json"])


func regenerate_argv(run_dir: String, candidate: String) -> PackedStringArray:
	return command + PackedStringArray(["vary", "--run", run_dir, "--candidate", candidate, "--runs", runs_dir(), "--json"])


## Runs the argv and waits. Safe to call from a thread.
func run(argv: PackedStringArray) -> Dictionary:
	ran.append(argv)
	var result := {
		"exit": -1,
		"outcome": "error",
		"message": "",
		"confirmCommand": "",
		"summary": "",
		"json": {},
	}
	if argv.is_empty() or argv[0] == "":
		result["message"] = "no command to run"
		return result
	var finished := _execute(argv)
	var code: int = finished["exit"]
	result["exit"] = code
	var parsed = null
	var stdout: String = finished["stdout"]
	if stdout != "":
		var json := JSON.new()
		if json.parse(stdout) == OK:
			parsed = json.data
	var body := {}
	if parsed is Dictionary:
		body = parsed
	result["json"] = body
	var error := {}
	if body.get("error") is Dictionary:
		error = body["error"]
	var error_code := String(error.get("code", ""))
	var message := ""
	if error.get("message") is String:
		message = error["message"]

	if code == 0:
		result["outcome"] = "done"
		if message == "":
			message = "done"
	elif code == 8 and error_code == "confirmation_required":
		result["outcome"] = "confirm"
		var confirmation := {}
		if error.get("confirmation") is Dictionary:
			confirmation = error["confirmation"]
		result["confirmCommand"] = String(confirmation.get("confirmCommand", ""))
		if confirmation.has("summary"):
			var summary = confirmation["summary"]
			result["summary"] = summary if summary is String else JSON.stringify(summary)
		if message == "":
			message = "confirmation required"
	elif code == 8 and error_code == "confirmation_declined":
		result["outcome"] = "declined"
		if message == "":
			message = "confirmation declined"
	elif message == "":
		if code == -1:
			message = "could not run " + argv[0]
		else:
			message = "%s exited with code %d" % [argv[0], code]
	result["message"] = message
	return result


## Runs the argv with its stdin, stdout and stderr all pipes, and returns its exit code and stdout.
## Pipes, not OS.execute: a child OS.execute starts on Windows can get a console, and core's CLI
## then prompts inline at a terminal nobody sees instead of exiting 8 with the command to confirm.
## Both outputs are drained while it runs, so a full stderr pipe cannot stall it.
func _execute(argv: PackedStringArray) -> Dictionary:
	var finished := {"exit": -1, "stdout": ""}
	var started := OS.execute_with_pipe(argv[0], argv.slice(1), false)
	if started.is_empty():
		return finished
	var pid: int = started["pid"]
	var stdio: FileAccess = started["stdio"]
	var stderr: FileAccess = started["stderr"]
	var out := PackedByteArray()
	while true:
		# Checked before draining, so whatever it wrote before exiting is read below.
		var running := OS.is_process_running(pid)
		var got_out := _drain(stdio)
		var got_err := _drain(stderr)
		out.append_array(got_out)
		if got_out.is_empty() and got_err.is_empty():
			if not running:
				break
			OS.delay_msec(20)
	stdio.close()
	stderr.close()
	finished["exit"] = OS.get_process_exit_code(pid)
	finished["stdout"] = out.get_string_from_utf8()
	return finished


## What the pipe holds now, without waiting for more.
func _drain(pipe: FileAccess) -> PackedByteArray:
	var bytes := PackedByteArray()
	while true:
		var chunk := pipe.get_buffer(65536)
		if chunk.is_empty():
			break
		bytes.append_array(chunk)
	return bytes
