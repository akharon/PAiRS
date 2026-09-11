"""Before/after safety net for in-place rewrites: always writes a revertable unified-diff
patch file next to the target, and additionally commits the change when the target sits
inside a clean git working tree (never auto-stashes or commits over dirty state — that
would blur SaRp's edit together with the user's in-progress work).
"""
from __future__ import annotations

import difflib
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SafetyResult:
    patch_path: Path
    git_commit: str | None
    git_skipped_reason: str | None


def write_patch(target: Path, original_text: str, new_text: str) -> Path:
    diff_lines = difflib.unified_diff(
        original_text.splitlines(keepends=True),
        new_text.splitlines(keepends=True),
        fromfile=f"a/{target.name}",
        tofile=f"b/{target.name}",
    )
    patch_path = target.with_name(target.name + ".sarp.patch")
    patch_path.write_text("".join(diff_lines))
    return patch_path


def _run_git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, timeout=15
    )


def check_git_preconditions(target: Path) -> str | None:
    """Checked BEFORE the rewrite so SaRp's own edit is never mistaken for pre-existing
    dirt. Returns None if a commit should be attempted after the rewrite, or a skip
    reason if not (not a repo, or the file already had uncommitted changes of the
    user's own that a SaRp commit would incorrectly bundle together with).
    """
    repo_check = _run_git(["rev-parse", "--is-inside-work-tree"], cwd=target.parent)
    if repo_check.returncode != 0:
        return "not inside a git repository"

    status = _run_git(["status", "--porcelain", "--", str(target)], cwd=target.parent)
    if status.returncode != 0:
        return "git status failed"
    if status.stdout.strip():
        return "file already had uncommitted changes before this rewrite; refusing to commit over them"

    return None


def maybe_git_commit(target: Path, description: str) -> tuple[str | None, str | None]:
    """Returns (commit_sha, skipped_reason). Never raises on git absence/failure — a
    missing git commit must not be treated as a fatal error for the rewrite itself.
    Call check_git_preconditions BEFORE rewriting target; pass its result in as the
    fast-path skip reason so dirtiness is judged on pre-rewrite state.
    """
    add = _run_git(["add", "--", str(target)], cwd=target.parent)
    if add.returncode != 0:
        return None, f"git add failed: {add.stderr.strip()}"

    commit = _run_git(
        ["commit", "-m", description, "--", str(target)],
        cwd=target.parent,
    )
    if commit.returncode != 0:
        return None, f"git commit failed: {commit.stderr.strip()}"

    sha = _run_git(["rev-parse", "HEAD"], cwd=target.parent)
    return (sha.stdout.strip() or None), None


def apply_with_safety_net(target: Path, original_text: str, new_text: str, description: str) -> SafetyResult:
    patch_path = write_patch(target, original_text, new_text)
    pre_rewrite_skip_reason = check_git_preconditions(target)

    target.write_text(new_text)

    if pre_rewrite_skip_reason is not None:
        return SafetyResult(patch_path=patch_path, git_commit=None, git_skipped_reason=pre_rewrite_skip_reason)

    commit_sha, skipped_reason = maybe_git_commit(target, description)
    return SafetyResult(patch_path=patch_path, git_commit=commit_sha, git_skipped_reason=skipped_reason)
