#!/usr/bin/env python3
"""
Deploy one or all Supabase Edge Functions to production.

Usage:
  python3 scripts/deploy.py                     # deploy all functions
  python3 scripts/deploy.py auth-register me    # deploy specific functions

The Supabase CLI (v2.x) queries terminal capabilities on startup and hangs
in non-TTY environments. This script uses Python's pty module to provide a
proper pseudo-terminal, and passes --use-api so bundling happens server-side
(no Docker needed). Functions that use bare specifiers (resend, stripe) get
--import-map automatically.

On 409 "deployment already exists" the script automatically deletes the
function and retries once — this clears stale deployment hash conflicts.
"""

import pty, os, select, subprocess, time, re, sys, glob
import urllib.request, json

PROJECT_REF = "hwvqbsqlvwvedyhfuiwt"
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(PROJECT_DIR, "supabase", "functions")
IMPORT_MAP = "supabase/functions/deno.json"
CONFIG_TOML = os.path.join(PROJECT_DIR, "supabase", "config.toml")

BARE_SPECIFIER_PATTERN = re.compile(r'import .+ from "[a-zA-Z]')


def no_jwt_functions() -> set:
    """Parse config.toml and return slugs that have verify_jwt = false."""
    slugs = set()
    current = None
    try:
        with open(CONFIG_TOML) as f:
            for line in f:
                m = re.match(r'^\[functions\.([^\]]+)\]', line.strip())
                if m:
                    current = m.group(1)
                elif current and re.match(r'^verify_jwt\s*=\s*false', line.strip()):
                    slugs.add(current)
    except FileNotFoundError:
        pass
    return slugs


NO_JWT = no_jwt_functions()


def _access_token() -> str:
    for path in [os.path.expanduser("~/.config/supabase/access-token"),
                 os.path.expanduser("~/.supabase/access-token")]:
        try:
            return open(path).read().strip()
        except FileNotFoundError:
            pass
    return os.environ.get("SUPABASE_ACCESS_TOKEN", "")


def delete_function(slug: str) -> bool:
    """Delete the function via Supabase CLI (uses its own auth, avoids token expiry)."""
    try:
        result = subprocess.run(
            ["supabase", "functions", "delete", slug, "--project-ref", PROJECT_REF],
            cwd=PROJECT_DIR, capture_output=True, text=True, timeout=30,
        )
        ok = result.returncode == 0
        if ok:
            print(f"  [retry] deleted {slug} from production", flush=True)
        else:
            print(f"  [warn] delete failed: {result.stderr.strip() or result.stdout.strip()}", flush=True)
        return ok
    except Exception as e:
        print(f"  [warn] delete failed: {e}", flush=True)
        return False


def needs_import_map(slug: str) -> bool:
    idx = os.path.join(FUNCTIONS_DIR, slug, "index.ts")
    try:
        with open(idx) as f:
            src = f.read()
    except FileNotFoundError:
        return False
    if BARE_SPECIFIER_PATTERN.search(src):
        return True
    # also check _shared imports referenced by this function
    for shared in glob.glob(os.path.join(FUNCTIONS_DIR, "_shared", "*.ts")):
        try:
            with open(shared) as f:
                if BARE_SPECIFIER_PATTERN.search(f.read()):
                    shared_name = os.path.basename(shared)
                    if shared_name.replace(".ts", "") in src:
                        return True
        except Exception:
            pass
    return False


def _run_deploy_cmd(slug: str, timeout: int = 240) -> tuple[bool, bool]:
    """Run the deploy CLI command. Returns (success, got_409)."""
    cmd = [
        "supabase", "functions", "deploy", slug,
        "--project-ref", PROJECT_REF, "--use-api",
    ]
    if needs_import_map(slug):
        cmd += ["--import-map", IMPORT_MAP]
    if slug in NO_JWT:
        cmd += ["--no-verify-jwt"]

    master, slave = pty.openpty()
    proc = subprocess.Popen(
        cmd, cwd=PROJECT_DIR, stdin=slave, stdout=slave, stderr=slave, close_fds=True
    )
    os.close(slave)

    output_lines: list[str] = []
    start = time.time()
    while proc.poll() is None and time.time() - start < timeout:
        r, _, _ = select.select([master], [], [], 0.3)
        if r:
            try:
                chunk = os.read(master, 4096)
                if b"\x1b]11;?" in chunk:
                    os.write(master, b"\x1b]11;rgb:0000/0000/0000\x07")
                if b"\x1b[6n" in chunk:
                    os.write(master, b"\x1b[1;1R")
                text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", chunk.decode("utf-8", errors="replace"))
                text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
                text = re.sub(r"\r", "\n", text)
                for line in text.splitlines():
                    s = line.strip()
                    if s and not set(s) <= {"⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}:
                        print(f"  {s}", flush=True)
                        output_lines.append(s)
            except OSError:
                break

    timed_out = proc.poll() is None
    if timed_out:
        proc.kill()
        print(f"  [timeout] deploy timed out after {timeout}s", flush=True)
    try:
        os.close(master)
    except Exception:
        pass

    if timed_out:
        return False, False

    got_409 = any(
        ("409" in l or "already exists" in l.lower()) for l in output_lines
    )

    if proc.returncode != 0 and not got_409:
        # Print full output so CI logs show the actual error
        if output_lines:
            print(f"  [error] deploy failed (exit {proc.returncode}). Captured output:", flush=True)
            for l in output_lines:
                print(f"    {l}", flush=True)
        else:
            print(f"  [error] deploy failed (exit {proc.returncode}) — no output captured", flush=True)

    return proc.returncode == 0, got_409


def deploy(slug: str) -> bool:
    ok, got_409 = _run_deploy_cmd(slug)
    if ok:
        return True
    if got_409:
        print(f"  [409] stale deployment hash — deleting and retrying {slug}", flush=True)
        if delete_function(slug):
            ok, _ = _run_deploy_cmd(slug)
            return ok
    return False


def all_function_slugs() -> list[str]:
    slugs = []
    for entry in os.scandir(FUNCTIONS_DIR):
        if entry.is_dir() and not entry.name.startswith("_") and not entry.name.startswith("."):
            if os.path.exists(os.path.join(entry.path, "index.ts")):
                slugs.append(entry.name)
    return sorted(slugs)


if __name__ == "__main__":
    targets = sys.argv[1:] if len(sys.argv) > 1 else all_function_slugs()
    results = {}
    for slug in targets:
        print(f"\n[{slug}] deploying...", flush=True)
        ok = deploy(slug)
        results[slug] = ok
        print(f"[{slug}] {'✓ done' if ok else '✗ FAILED'}", flush=True)

    print("\n=== Summary ===")
    failed = [s for s, ok in results.items() if not ok]
    print(f"  Deployed: {len(results) - len(failed)}/{len(results)}")
    if failed:
        print(f"  Failed:   {', '.join(failed)}")
        sys.exit(1)
