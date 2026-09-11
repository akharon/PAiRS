from __future__ import annotations

import subprocess

from sarp.safety import apply_with_safety_net, check_git_preconditions, write_patch


def _git(args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)


def _init_repo(root):
    _git(["init", "-q"], root)
    _git(["config", "user.email", "test@test.com"], root)
    _git(["config", "user.name", "Test"], root)


def test_write_patch_produces_valid_unified_diff(cpp_project):
    header = cpp_project.write("widget.h", "line1\nline2\nline3\n")
    original = header.read_text()
    new_text = "line1\nCHANGED\nline3\n"

    patch_path = write_patch(header, original, new_text)

    assert patch_path.name == "widget.h.sarp.patch"
    content = patch_path.read_text()
    assert "-line2" in content
    assert "+CHANGED" in content


def test_check_git_preconditions_not_a_repo(cpp_project):
    header = cpp_project.write("widget.h", "content\n")
    reason = check_git_preconditions(header)
    assert reason is not None
    assert "not inside a git repository" in reason


def test_check_git_preconditions_clean_repo(cpp_project):
    header = cpp_project.write("widget.h", "content\n")
    _init_repo(cpp_project.root)
    _git(["add", "-A"], cpp_project.root)
    _git(["commit", "-m", "initial"], cpp_project.root)

    reason = check_git_preconditions(header)
    assert reason is None


def test_check_git_preconditions_dirty_file_refuses(cpp_project):
    header = cpp_project.write("widget.h", "content\n")
    _init_repo(cpp_project.root)
    _git(["add", "-A"], cpp_project.root)
    _git(["commit", "-m", "initial"], cpp_project.root)

    header.write_text("content\nmore uncommitted stuff\n")

    reason = check_git_preconditions(header)
    assert reason is not None
    assert "uncommitted changes" in reason


def test_apply_with_safety_net_commits_in_clean_repo(cpp_project):
    header = cpp_project.write("widget.h", "line1\nline2\n")
    _init_repo(cpp_project.root)
    _git(["add", "-A"], cpp_project.root)
    _git(["commit", "-m", "initial"], cpp_project.root)

    original = header.read_text()
    new_text = "line1\nCHANGED\n"

    result = apply_with_safety_net(header, original, new_text, "test rewrite")

    assert header.read_text() == new_text
    assert result.patch_path.exists()
    assert result.git_commit is not None
    assert result.git_skipped_reason is None

    log = _git(["log", "--oneline"], cpp_project.root).stdout
    assert "test rewrite" in log


def test_apply_with_safety_net_skips_commit_outside_repo(cpp_project):
    header = cpp_project.write("widget.h", "line1\nline2\n")
    original = header.read_text()
    new_text = "line1\nCHANGED\n"

    result = apply_with_safety_net(header, original, new_text, "test rewrite")

    assert header.read_text() == new_text
    assert result.patch_path.exists()
    assert result.git_commit is None
    assert "not inside a git repository" in result.git_skipped_reason


def test_apply_with_safety_net_skips_commit_when_dirty_but_still_writes_patch(cpp_project):
    header = cpp_project.write("widget.h", "line1\nline2\n")
    _init_repo(cpp_project.root)
    _git(["add", "-A"], cpp_project.root)
    _git(["commit", "-m", "initial"], cpp_project.root)
    header.write_text("line1\nline2\npre-existing uncommitted change\n")

    original = header.read_text()
    new_text = "line1\nCHANGED\npre-existing uncommitted change\n"

    result = apply_with_safety_net(header, original, new_text, "test rewrite")

    assert header.read_text() == new_text
    assert result.patch_path.exists()
    assert result.git_commit is None
    assert "uncommitted changes" in result.git_skipped_reason
