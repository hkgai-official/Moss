"""Unit tests for trial_runner.

Real end-to-end (docker run + benchmark.py + grader) is gated behind a
skipped marker — it requires a built ``moss:slice3-test`` image which
doesn't exist until (deferred). The pure-logic helpers (manifest loader,
work-queue builder, run_id format, result-path construction) are fully
unit-tested here.
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest
import yaml

from src.ops import trial_runner


# ------------------------------------------------------------------
# Pure helpers
# ------------------------------------------------------------------
def test_load_manifest_tasks_extracts_id_and_baseline():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        yaml.safe_dump({
            "name": "fake_batch",
            "tasks": [
                {"id": "T001", "baseline_score": 0.5},
                {"id": "T002", "baseline_score": 0.7},
                {"id": "T003"},  # no baseline → defaults to 0.0
            ],
        }, f)
        p = f.name
    try:
        tasks = trial_runner.load_manifest_tasks(p)
        assert [t["id"] for t in tasks] == ["T001", "T002", "T003"]
    finally:
        os.unlink(p)


def test_load_manifest_tasks_empty():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        yaml.safe_dump({"name": "empty"}, f)
        p = f.name
    try:
        assert trial_runner.load_manifest_tasks(p) == []
    finally:
        os.unlink(p)


def test_build_work_items_cartesian_product():
    tasks = [
        {"id": "T001", "baseline_score": 0.5},
        {"id": "T002"},
    ]
    items = trial_runner.build_work_items(tasks, n_trials=3)
    assert len(items) == 6  # 2 tasks × 3 trials
    # baseline coerced to float; missing → 0.0
    assert items[0] == ("T001", 0.5, 1)
    assert items[5] == ("T002", 0.0, 3)
    # trial numbers are 1-indexed
    assert {n for (_, _, n) in items} == {1, 2, 3}


def test_make_run_id_stable_format():
    r = trial_runner.make_run_id(
        "/tmp/manifests/batch_03_customer_relationship_manifest.yaml",
        iter_n="0", task_id="T139zh", trial_n=2,
    )
    assert r == "evo/batch_03_customer_relationship_manifest/iter0/T139zh-t2"


def test_result_path_for_matches_benchmark_layout():
    """benchmark.py:136 → results_dir = RESULTS_ROOT / run_id / task_id.
    RESULTS_ROOT is benchmark/claw-eval/results."""
    p = trial_runner.result_path_for(
        "/data/moss",
        run_id="evo/batch_03/iter0/T139-t1",
        task_id="T139",
    )
    assert str(p) == (
        "/data/moss/benchmark/claw-eval/results/"
        "evo/batch_03/iter0/T139-t1/T139/result.json"
    )


# ------------------------------------------------------------------
# Manifest loader: missing file
# ------------------------------------------------------------------
@pytest.mark.asyncio
async def test_handle_run_trial_missing_manifest(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "MOSS_OPENCLAW_REPO_DIR", str(tmp_path / "openclaw_inner"),
    )
    msgs = []
    async for r in trial_runner.handle_run_trial("rt1", {
        "image_tag": "moss:slice3-test",
        "manifest_path": "/nonexistent/__manifest__.yaml",
        "n_trials": 1,
        "iter_dir": str(tmp_path / "iter"),
        "stage": "a",
        "n_workers": 1,
    }):
        msgs.append(r)
    assert any(m.type == "error" for m in msgs), msgs
    err = next(m for m in msgs if m.type == "error")
    assert "manifest" in err.data["message"].lower()


@pytest.mark.asyncio
async def test_handle_run_trial_empty_manifest(monkeypatch, tmp_path):
    """Manifest with zero tasks must yield error (not silent empty result)."""
    manifest_p = tmp_path / "empty.yaml"
    manifest_p.write_text("name: empty\n")
    monkeypatch.setenv(
        "MOSS_OPENCLAW_REPO_DIR", str(tmp_path / "openclaw_inner"),
    )
    msgs = []
    async for r in trial_runner.handle_run_trial("rt2", {
        "image_tag": "moss:slice3-test",
        "manifest_path": str(manifest_p),
        "n_trials": 1,
        "iter_dir": str(tmp_path / "iter"),
        "stage": "a",
        "n_workers": 1,
    }):
        msgs.append(r)
    err = next((m for m in msgs if m.type == "error"), None)
    assert err is not None
    assert "no tasks" in err.data["message"].lower()


# ------------------------------------------------------------------
# Real end-to-end smoke (gated)
# ------------------------------------------------------------------
@pytest.mark.skip(
    reason="real trial requires built moss:slice3-test image — covered in (deferred)",
)
@pytest.mark.asyncio
async def test_trial_runner_one_task_one_trial():
    """1 task × 1 trial × 1 worker — should produce grade_summary_stage_a.json."""
    from src.ops import trial_runner as tr  # noqa: F401
    iter_dir = Path(tempfile.mkdtemp(prefix="moss-trial-test-"))
    payload = {
        "image_tag": "moss:slice3-test",
        "manifest_path": (
            "/data/moss/benchmark/claw-eval/runner/"
            "manifests/batch_03_customer_relationship_manifest.yaml"
        ),
        "n_trials": 1,
        "iter_dir": str(iter_dir),
        "stage": "a",
        "n_workers": 1,
    }
    msgs = []
    async for r in trial_runner.handle_run_trial("rt-smoke", payload):
        msgs.append(r)
    result = next((m for m in msgs if m.type == "result"), None)
    assert result is not None
    summary_p = Path(result.data["grade_summary_path"])
    assert summary_p.exists()
    summary = json.loads(summary_p.read_text())
    assert isinstance(summary, list)
    assert all("task" in g and "trial" in g and "score" in g for g in summary)


# ------------------------------------------------------------------
# iter_n normalization
# ------------------------------------------------------------------
@pytest.mark.parametrize("inp,expected", [
    ("/tmp/foo/iteration_3", "3"),
    ("/tmp/foo/iter0", "0"),
    ("/tmp/foo/5", "5"),
    ("/tmp/iteration_10", "10"),
])
def test_normalize_iter_n(inp, expected):
    assert trial_runner._normalize_iter_n(inp) == expected
