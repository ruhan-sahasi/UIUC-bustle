import shutil
from pathlib import Path

from outreach.cli import _middle_paragraphs, main

EXAMPLES = Path(__file__).resolve().parent.parent / "config"


def test_init_and_offline_check(tmp_path, capsys, monkeypatch):
    config = tmp_path / "config"
    config.mkdir()
    for f in EXAMPLES.glob("*.example.yaml"):
        shutil.copy(f, config / f.name)
    assert main(["--config-dir", str(config), "--data-dir", str(tmp_path / "data"), "init"]) == 0
    assert {p.name for p in config.glob("*.yaml")} >= {"settings.yaml", "profile.yaml", "targets.yaml"}
    assert (tmp_path / ".env").exists() and not (EXAMPLES.parent / ".env").exists()
    for var in ("APOLLO_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OUTREACH_EMAIL_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    code = main(["--config-dir", str(config), "--data-dir", str(tmp_path / "data"), "check", "--offline"])
    out = capsys.readouterr().out
    assert code == 1 and "[ok] config: 1 targets" in out and "[FAIL] APOLLO_API_KEY" in out


def test_status_on_empty_ledger(tmp_path, capsys):
    config = tmp_path / "config"
    config.mkdir()
    for f in EXAMPLES.glob("*.example.yaml"):
        shutil.copy(f, config / f.name.replace(".example", ""))
    assert main(["--config-dir", str(config), "--data-dir", str(tmp_path / "data"), "status"]) == 0
    assert "example-corp-software-engineering" in capsys.readouterr().out


def test_middle_paragraphs():
    body = "Hi Riley,\n\nOne.\n\nTwo.\n\nThank you for reading and I look forward to hearing back!\n\nWarm Regards,\nJ"
    assert _middle_paragraphs(body, ["Thank you for reading and I look forward to hearing back!"]) == ["One.", "Two."]
