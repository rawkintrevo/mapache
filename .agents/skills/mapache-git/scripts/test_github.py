"""Offline helper contract tests: python3 scripts/test_github.py."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HELPER = Path(__file__).with_name("github.sh")


class GithubHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        for name in ("gh", "git"):
            path = Path(self.temp.name, name)
            path.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "print(json.dumps({'command': os.path.basename(sys.argv[0]), "
                "'args': sys.argv[1:], 'token': os.getenv('GH_TOKEN'), "
                "'prompt': os.getenv('GIT_TERMINAL_PROMPT')}))\n"
                "sys.exit(int(os.getenv('MOCK_EXIT', '0')))\n"
            )
            path.chmod(0o700)
        self.env = {k: v for k, v in os.environ.items()
                    if k not in ("GH_TOKEN", "GITHUB_AUTOMATION_TOKEN", "GH_DEBUG", "SHELLOPTS", "BASH_ENV")}
        self.env["PATH"] = self.temp.name + os.pathsep + self.env["PATH"]

    def run_helper(self, *args, **env):
        return subprocess.run(["bash", str(HELPER), *args],
                              env={**self.env, **env}, text=True, capture_output=True)

    def test_runner_token_preferred_and_arguments_preserved(self):
        result = self.run_helper("gh", "issue", "create", "--title", "two words",
                                 GITHUB_AUTOMATION_TOKEN="fake-runner", GH_TOKEN="fake-other")
        self.assertEqual(result.returncode, 0)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["token"], "fake-runner")
        self.assertEqual(payload["args"], ["issue", "create", "--title", "two words"])

    def test_existing_token_fallback(self):
        payload = json.loads(self.run_helper("gh", "api", GH_TOKEN="fake-existing").stdout)
        self.assertEqual(payload["token"], "fake-existing")

    def test_no_token_is_not_invented(self):
        self.assertIsNone(json.loads(self.run_helper("gh", "api").stdout)["token"])

    def test_git_configuration_is_invocation_local(self):
        payload = json.loads(self.run_helper("git", "push", "origin", "topic").stdout)
        self.assertEqual(payload["command"], "git")
        self.assertEqual(payload["args"], ["-c", "credential.helper=", "-c",
                         "credential.helper=!gh auth git-credential", "push", "origin", "topic"])
        self.assertEqual(payload["prompt"], "0")

    def test_failure_propagates(self):
        self.assertEqual(self.run_helper("gh", "api", MOCK_EXIT="7").returncode, 7)

    def test_invalid_mode(self):
        self.assertEqual(self.run_helper("invalid").returncode, 2)
        self.assertEqual(self.run_helper().returncode, 2)


if __name__ == "__main__":
    unittest.main()
