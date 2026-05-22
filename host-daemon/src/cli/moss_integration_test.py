"""Integration test: spin up a real host-daemon on a tmp socket, invoke moss CLI."""
import os
import subprocess
import time
import socket
import pytest

INTEGRATION = os.environ.get("MOSS_INTEGRATION") == "1"

@pytest.mark.skipif(not INTEGRATION, reason="MOSS_INTEGRATION not set")
def test_flag_via_real_daemon(tmp_path):
    # This is a placeholder for engineer to flesh out. Goal: start a real daemon,
    # invoke `moss evo flag --agent A --session S`, verify a chunk is written.
    pass
