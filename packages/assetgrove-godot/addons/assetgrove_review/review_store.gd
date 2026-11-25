# Reads Assetgrove's local run folders for the review dock: the runs under
# `<target>/.assetgrove/runs`, each candidate with its provenance and QA reasons, and its review
# record (`assetgrove-review/2`, read tolerantly line by line). It only reads, and only below the
# runs folder; `opened` lists everything it touched. Every read goes through the helpers under
# "Reads", which record the path first; `test/review-dock-reads.test.ts` holds the addon to that.
@tool
extends RefCounted

var runs_dir: String = ""
## Every file or directory this store opened or listed, as an absolute path.
var opened: PackedStringArray = []


func _init(dir: String) -> void:
	runs_dir = dir


## One entry per run: {id, assetId, kind, candidates (ids), picked}, sorted by id.
func list_runs() -> Array:
	var out: Array = []
	var names := _list_dirs(runs_dir)
	names.sort()
	for entry in names:
		if entry.begins_with("."):
			continue
		var run_dir := runs_dir.path_join(entry)
		var run = _read_run(run_dir)
		if run == null:
			continue
		var spec := _sub(run, "spec")
		var ids: Array[String] = []
		var cands = run.get("candidates")
		if cands is Array:
			for cand in cands:
				if cand is Dictionary:
					ids.append(String(cand.get("id", "")))
		out.append({
			"id": entry,
			"assetId": String(spec.get("assetId", "")),
			"kind": String(spec.get("kind", "")),
			"candidates": ids,
			"picked": _picked(run),
		})
	return out


## The candidate with its provenance and review state, or {} when it cannot be read.
func load_candidate(run_id: String, candidate_id: String) -> Dictionary:
	if not _safe_segment(run_id) or not _safe_segment(candidate_id):
		return {}
	var run_dir := runs_dir.path_join(run_id)
	var run = _read_run(run_dir)
	if run == null:
		return {}
	var found := {}
	var cands = run.get("candidates")
	if cands is Array:
		for cand in cands:
			if cand is Dictionary and String(cand.get("id", "")) == candidate_id:
				found = cand
				break
	if found.is_empty():
		return {}
	var reasons: Array = []
	if found.get("reasons") is Array:
		reasons = found["reasons"]
	var review := _read_review(run_dir, candidate_id, _picked(run) == candidate_id)
	return {
		"run": run_id,
		"run_dir": run_dir,
		"id": candidate_id,
		"file": _safe_file(run_dir, String(found.get("file", ""))),
		"mediaType": String(found.get("mediaType", "")),
		"sha256": String(found.get("sha256", "")),
		"reasons": reasons,
		"fields": _sub(found, "fields"),
		"provenance": _sub(found, "provenance"),
		"review": review,
		"state": review["status"],
	}


func preview(candidate: Dictionary) -> Texture2D:
	var file := String(candidate.get("file", ""))
	if not String(candidate.get("mediaType", "")).begins_with("image/") or file == "":
		return null
	var image := _load_image(file)
	if image == null or image.is_empty():
		return null
	return ImageTexture.create_from_image(image)


## The candidate's run, state, provenance, QA reasons and review notes as plain text.
func provenance_text(candidate: Dictionary) -> String:
	var lines := PackedStringArray()
	lines.append("run: " + String(candidate.get("run", "")))
	lines.append("candidate: " + String(candidate.get("id", "")))
	lines.append("state: " + String(candidate.get("state", "")))
	lines.append("mediaType: " + String(candidate.get("mediaType", "")))
	lines.append("sha256: " + String(candidate.get("sha256", "")))
	var provenance := _sub(candidate, "provenance")
	for key in ["route", "models", "model", "prompt", "seed", "requestId", "requestIds", "time", "createdAt", "startedAt", "costUsd", "generator"]:
		if provenance.has(key):
			lines.append("%s: %s" % [key, _show(provenance[key], true)])
	var reasons = candidate.get("reasons")
	if reasons is Array and not reasons.is_empty():
		lines.append("QA:")
		for reason in reasons:
			if reason is Dictionary:
				lines.append("  %s %s: %s" % [
					_show(reason.get("check", ""), false),
					"passed" if reason.get("passed", false) == true else "failed",
					_show(reason.get("reason", ""), false),
				])
	var review := _sub(candidate, "review")
	var notes = review.get("annotations")
	if notes is Array and not notes.is_empty():
		lines.append("Review:")
		for note in notes:
			if note is Dictionary:
				lines.append("  %s %s %s %s" % [
					_show(note.get("created", ""), false),
					_show(note.get("motivation", ""), false),
					_show(note.get("ag:action", ""), false),
					_body_value(note),
				])
	return "\n".join(lines)


func _read_run(run_dir: String):
	var data = _read_json(run_dir.path_join("run.json"))
	if data is Dictionary:
		return data
	return null


func _read_json(path: String):
	if not _exists(path):
		return null
	return _parse(_read_text(path))


func _parse(text: String):
	var json := JSON.new()
	if json.parse(text) != OK:
		return null
	return json.data


func _picked(run: Dictionary) -> String:
	return String(_sub(run, "picked").get("candidateId", ""))


func _sub(source: Dictionary, key: String) -> Dictionary:
	var value = source.get(key)
	if value is Dictionary:
		return value
	return {}


func _safe_segment(segment: String) -> bool:
	return segment != "" and not segment.begins_with(".") and not segment.contains("/") and not segment.contains("\\")


func _safe_file(run_dir: String, file: String) -> String:
	if file == "" or file.is_absolute_path() or file.contains("\\") or file.begins_with("/"):
		return ""
	if ".." in file.split("/"):
		return ""
	return run_dir.path_join(file)


func _read_review(run_dir: String, candidate_id: String, is_picked: bool) -> Dictionary:
	var path := run_dir.path_join("reviews").path_join(candidate_id + ".review.json")
	var items: Array = []
	var record := ""
	if _exists(path):
		record = path
		var text := _read_text(path)
		var strict = _parse(text)
		if strict is Dictionary:
			var first = strict.get("first")
			if first is Dictionary and first.get("items") is Array:
				for item in first["items"]:
					if _is_annotation(item):
						items.append(item)
		else:
			for line in text.split("\n"):
				var trimmed := line.strip_edges()
				while trimmed.ends_with(","):
					trimmed = trimmed.substr(0, trimmed.length() - 1).strip_edges()
				if not trimmed.begins_with("{"):
					continue
				var item = _parse(trimmed)
				if _is_annotation(item):
					items.append(item)
	var seen := {}
	var annotations: Array = []
	for item in items:
		var id := String(item["id"])
		if seen.has(id):
			continue
		seen[id] = true
		annotations.append(item)
	annotations.sort_custom(_before)
	return {
		"record": record,
		"status": _status(annotations, is_picked),
		"annotations": annotations,
	}


func _is_annotation(item) -> bool:
	return item is Dictionary and item.get("id") is String and String(item["id"]).begins_with("#")


func _before(a: Dictionary, b: Dictionary) -> bool:
	var ca := String(a.get("created", ""))
	var cb := String(b.get("created", ""))
	if ca != cb:
		return ca < cb
	return String(a.get("id", "")) < String(b.get("id", ""))


func _status(annotations: Array, is_picked: bool) -> String:
	if is_picked:
		return "picked"
	var latest := {}
	for note in annotations:
		if note.get("motivation") == "assessing":
			latest = note
	var action := String(latest.get("ag:action", ""))
	if action == "reject":
		return "rejected"
	if action == "approve":
		return "approved"
	var resolved := {}
	for note in annotations:
		if note.get("motivation") == "moderating" and note.get("ag:action") == "resolve":
			var named = note.get("ag:resolves")
			if named is Array:
				for each in named:
					resolved[String(each)] = true
			elif named is String:
				resolved[named] = true
	for note in annotations:
		if note.get("motivation") == "editing" and not resolved.has(String(note["id"])):
			return "changes-requested"
	return "pending"


func _body_value(note: Dictionary) -> String:
	var body = note.get("body")
	var first = null
	if body is Array and not body.is_empty():
		first = body[0]
	elif body is Dictionary:
		first = body
	if first is Dictionary:
		if first.has("value"):
			return _show(first["value"], false)
		if first.has("source"):
			return _show(first["source"], false)
	return ""


## A value as `key: value` text: strings as they are, whole numbers without ".0", a list joined.
func _show(value, join_lists: bool) -> String:
	if value is String:
		return value
	if value is float and value == floorf(value) and absf(value) < 1.0e15:
		return str(int(value))
	if join_lists and value is Array:
		var parts := PackedStringArray()
		for part in value:
			parts.append(_show(part, false))
		return ", ".join(parts)
	return JSON.stringify(value)


# Reads: the only functions here that touch the file system. Each records its path in `opened`
# before it reads.


## The names of the directories in `path`, or none when it cannot be listed.
func _list_dirs(path: String) -> PackedStringArray:
	opened.append(path)
	var dir := DirAccess.open(path)
	if dir == null:
		return PackedStringArray()
	return dir.get_directories()


func _exists(path: String) -> bool:
	opened.append(path)
	return FileAccess.file_exists(path)


func _read_text(path: String) -> String:
	opened.append(path)
	return FileAccess.get_file_as_string(path)


func _load_image(path: String) -> Image:
	opened.append(path)
	return Image.load_from_file(path)
