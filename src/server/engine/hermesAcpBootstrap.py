"""MSG's process-local permission boundary for the inspected Hermes ACP adapter.

Hermes 0.18.2 reloads .env with override=True and can globally disable approvals.
Keep its real authentication/session store while forcing manual native requests;
MSG answers each request using the user's live mode. Never modify native files.
"""
import contextlib
import copy
import os
import sys

SUPPORTED_VERSION = "0.18.2"


def install_policy():
    from hermes_cli import __version__
    if __version__ != SUPPORTED_VERSION:
        raise RuntimeError("Unsupported Hermes version; MSG ACP policy needs review")
    from hermes_cli import env_loader
    from hermes_cli import config

    def clamp_environment():
        os.environ["HERMES_YOLO_MODE"] = "0"
        os.environ["HERMES_ACCEPT_HOOKS"] = "0"
        for key in ("HERMES_GATEWAY_SESSION", "HERMES_CRON_SESSION"):
            os.environ.pop(key, None)

    original_loader = env_loader.load_hermes_dotenv

    def load_env(*args, **kwargs):
        try:
            return original_loader(*args, **kwargs)
        finally:
            clamp_environment()

    env_loader.load_hermes_dotenv = load_env
    clamp_environment()

    def guarded(loader):
        def load(*args, **kwargs):
            value = copy.deepcopy(loader(*args, **kwargs))
            if not isinstance(value, dict):
                raise RuntimeError("Unsupported Hermes configuration")
            approvals = dict(value.get("approvals") or {})
            approvals["mode"] = "manual"
            value["approvals"] = approvals
            value["hooks_auto_accept"] = False
            return value
        return load

    config.load_config = guarded(config.load_config)
    config.load_config_readonly = guarded(config.load_config_readonly)
    from acp_adapter import entry
    entry._load_env()
    from tools import approval
    # The native module freezes YOLO at import time, including early imports.
    if not hasattr(approval, "_YOLO_MODE_FROZEN") or not isinstance(approval._session_yolo, set):
        raise RuntimeError("Unsupported Hermes approval API")
    approval._YOLO_MODE_FROZEN = False
    approval._session_yolo.clear()

    def no_native_yolo(*_args, **_kwargs):
        raise RuntimeError("Choose automatic approval in MSG instead")

    approval.enable_session_yolo = no_native_yolo
    if approval.is_approval_bypass_active() or approval._get_approval_mode() != "manual":
        raise RuntimeError("Hermes manual approval assertion failed")
    if config.load_config().get("hooks_auto_accept") is not False:
        raise RuntimeError("Hermes hook approval assertion failed")
    return entry


def main():
    try:
        with contextlib.redirect_stdout(sys.stderr):
            entry = install_policy()
        if sys.argv[1:] == ["--check-policy"]:
            # Only this fixed boolean escapes the offline check, never config/env.
            print('{"msgPolicySafe": true}')
            return
        sys.argv = ["hermes-acp"]
        entry.main()
    except Exception:
        # Native initialization errors may contain auth values. Do not print them.
        sys.stderr.write("MSG Hermes ACP policy/bootstrap failed; check supported version 0.18.2.\n")
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
