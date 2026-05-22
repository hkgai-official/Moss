"""docker-build / hard-reset-openclaw tests.

The real docker build test runs `sudo docker build` on a 1-line Dockerfile
and asserts an image_id is returned. Skipped if docker is unreachable.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

import pytest

from src.ops import docker_rpc
from src.protocol import Response


def _docker_reachable() -> bool:
    # Use whatever docker_rpc.DOCKER_BIN resolved to — this honors MOSS_DOCKER_BIN
    # the same way production does, so OSS users in the docker group skip-skip
    # while hosts that need sudo can `export MOSS_DOCKER_BIN="docker"`.
    try:
        proc = subprocess.run(
            [*docker_rpc.DOCKER_BIN, "version", "--format", "{{.Server.Version}}"],
            capture_output=True, timeout=10,
        )
        return proc.returncode == 0
    except Exception:
        return False


REQUIRES_DOCKER = pytest.mark.skipif(
    not _docker_reachable(),
    reason="docker daemon not reachable via configured MOSS_DOCKER_BIN",
)


@REQUIRES_DOCKER
@pytest.mark.asyncio
async def test_docker_build_real():
    """Build a trivial alpine image and verify image_id + size returned."""
    with tempfile.TemporaryDirectory() as td:
        # 1-line dockerfile referencing an already-cached base would be ideal.
        # We use `scratch` + a label so this never pulls anything.
        (Path(td) / "Dockerfile").write_text(textwrap.dedent("""\
            FROM scratch
            LABEL evoclaw_test=slice3
        """))
        tag = "moss-slice3-build-test:latest"

        events: list[Response] = []
        result: Response | None = None
        error: Response | None = None
        async for r in docker_rpc.handle_build(
            "rb1", {"tag": tag, "context_dir": td, "timeout_s": 120},
        ):
            if r.type == "event":
                events.append(r)
            elif r.type == "result":
                result = r
                break
            elif r.type == "error":
                error = r
                break

        # Cleanup the test image regardless of outcome
        try:
            subprocess.run(
                [*docker_rpc.DOCKER_BIN, "rmi", "-f", tag],
                capture_output=True, timeout=30,
            )
        except Exception:
            pass

        assert error is None, f"unexpected error: {error.data if error else None}"
        assert result is not None, "no result event"
        assert "image_id" in result.data
        assert result.data["image_id"].startswith("sha256:")
        assert isinstance(result.data["size_mb"], int)


@REQUIRES_DOCKER
@pytest.mark.asyncio
async def test_docker_build_bad_context_returns_error():
    """A nonexistent context dir must surface as a structured error/non-zero exit."""
    result: Response | None = None
    error: Response | None = None
    async for r in docker_rpc.handle_build(
        "rb2",
        {"tag": "moss-slice3-bad:latest",
         "context_dir": "/nonexistent/path/__evoclaw_test__",
         "timeout_s": 30},
    ):
        if r.type == "result":
            result = r; break
        if r.type == "error":
            error = r; break
    assert error is not None or (result is not None and result.data.get("image_id") is None), (
        "expected error for bad context"
    )


@pytest.mark.asyncio
async def test_hard_reset_openclaw_invalid_repo_yields_error(monkeypatch):
    """No real openclaw repo touched: point env at a tempdir without git
    and assert handler returns a structured error."""
    with tempfile.TemporaryDirectory() as td:
        monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", td)
        msgs = []
        async for r in docker_rpc.handle_hard_reset(
            "rh1", {"h_pre": "deadbeef0000000000000000000000000000beef"},
        ):
            msgs.append(r)
        # Either error (no git repo / unknown sha) — must NOT silently succeed.
        assert any(m.type == "error" for m in msgs), msgs


def _init_repo(repo_dir: Path) -> None:
    """Set up a minimal git repo with one commit so HEAD resolves."""
    for cmd in [
        ["git", "init", "-q", "-b", "master", str(repo_dir)],
        ["git", "-C", str(repo_dir), "config", "user.email", "moss-test@moss.local"],
        ["git", "-C", str(repo_dir), "config", "user.name", "moss-test"],
        ["git", "-C", str(repo_dir), "config", "commit.gpgsign", "false"],
    ]:
        subprocess.run(cmd, check=True, capture_output=True)
    (repo_dir / "README").write_text("seed\n")
    subprocess.run(
        ["git", "-C", str(repo_dir), "add", "README"], check=True, capture_output=True,
    )
    subprocess.run(
        ["git", "-C", str(repo_dir), "commit", "-q", "-m", "seed"],
        check=True, capture_output=True,
    )


@pytest.mark.asyncio
async def test_commit_openclaw_iter_no_changes_returns_current_head(monkeypatch):
    """Tree clean — handler must skip the commit step and return current
    HEAD with staged=False (idempotent on no-op iters)."""
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _init_repo(repo)
        head_pre = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

        monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", str(repo))
        msgs = []
        async for r in docker_rpc.handle_commit_openclaw_iter("rc1", {"iter": 1}):
            msgs.append(r)
        assert len(msgs) == 1, msgs
        assert msgs[0].type == "result", msgs
        assert msgs[0].data["commit_hash"] == head_pre
        assert msgs[0].data["staged"] is False


@pytest.mark.asyncio
async def test_commit_openclaw_iter_with_changes_creates_commit(monkeypatch):
    """Dirty tree — handler must `add -A` + commit and return the new HEAD
    (different from pre-commit HEAD), with staged=True."""
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _init_repo(repo)
        head_pre = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        # Leave an unstaged mod so handle_commit_openclaw_iter has work to do.
        (repo / "new_file.txt").write_text("payload\n")

        monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", str(repo))
        msgs = []
        async for r in docker_rpc.handle_commit_openclaw_iter("rc2", {"iter": 7}):
            msgs.append(r)
        assert any(m.type == "result" for m in msgs), msgs
        result = next(m for m in msgs if m.type == "result")
        assert result.data["staged"] is True
        assert result.data["commit_hash"] != head_pre
        # Confirm commit message was applied.
        msg = subprocess.run(
            ["git", "-C", str(repo), "log", "-1", "--pretty=%s"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()
        assert msg == "evolved iter 7"


@pytest.mark.asyncio
async def test_commit_openclaw_iter_missing_repo_yields_error(monkeypatch):
    """MOSS_OPENCLAW_REPO_DIR pointing at a non-directory: structured error,
    not a crash."""
    monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", "/nonexistent/evoclaw_test_path")
    msgs = []
    async for r in docker_rpc.handle_commit_openclaw_iter("rc3", {"iter": 1}):
        msgs.append(r)
    assert len(msgs) == 1, msgs
    assert msgs[0].type == "error"


# ---------------------------------------------------------------------------
# get-baseline-commit — preflight RPC for evolution gateway (replaces the
# now-deleted fs.existsSync + execFileSync inside the container; see
# docs/specs/2026-05-18-evolution-preflight-rpc.md).
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_baseline_commit_ok(monkeypatch):
    """A real git repo with one commit: returns {h_pre, repo_dir} matching."""
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)
        _init_repo(repo)
        head = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            check=True, capture_output=True, text=True,
        ).stdout.strip()

        monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", str(repo))
        msgs = []
        async for r in docker_rpc.handle_get_baseline_commit("gb1", {}):
            msgs.append(r)
        assert len(msgs) == 1, msgs
        assert msgs[0].type == "result", msgs
        assert msgs[0].data["h_pre"] == head
        assert msgs[0].data["repo_dir"] == str(repo)


@pytest.mark.asyncio
async def test_get_baseline_commit_no_env_yields_error(monkeypatch):
    """MOSS_OPENCLAW_REPO_DIR unset: structured error mentioning 'not set'."""
    monkeypatch.delenv("MOSS_OPENCLAW_REPO_DIR", raising=False)
    msgs = []
    async for r in docker_rpc.handle_get_baseline_commit("gb2", {}):
        msgs.append(r)
    assert len(msgs) == 1, msgs
    assert msgs[0].type == "error"
    assert "not set" in msgs[0].data["message"].lower()


@pytest.mark.asyncio
async def test_get_baseline_commit_not_a_repo_yields_error(monkeypatch):
    """MOSS_OPENCLAW_REPO_DIR points at a directory without .git: structured
    error mentioning 'not a git repo'."""
    with tempfile.TemporaryDirectory() as td:
        # Bare tempdir — no .git/ inside.
        monkeypatch.setenv("MOSS_OPENCLAW_REPO_DIR", td)
        msgs = []
        async for r in docker_rpc.handle_get_baseline_commit("gb3", {}):
            msgs.append(r)
        assert len(msgs) == 1, msgs
        assert msgs[0].type == "error"
        assert "not a git repo" in msgs[0].data["message"].lower()
