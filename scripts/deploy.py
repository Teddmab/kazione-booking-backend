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
"""

import pty, os, select, subprocess, time, re, sys, glob

PROJECT_REF = "hwvqbsqlvwvedyhfuiwt"
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FUNCTIONS_DIR = os.path.join(PROJECT_DIR, "supabase", "functions")
IMPORT_MAP = "supabase/functions/deno.json"

BARE_SPECIFIER_PATTERN = re.compile(r'import .+ from "[a-zA-Z]')


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
                    # only matters if this function imports that shared file
                    shared_name = os.path.basename(shared)
                    if shared_name.replace(".ts", "") in src:
                        return True
        except Exception:
            pass
    return False


def deploy(slug: str) -> bool:
    cmd = [
        "npx", "supabase", "functions", "deploy", slug,
        "--project-ref", PROJECT_REF, "--use-api",
    ]
    if needs_import_map(slug):
        cmd += ["--import-map", IMPORT_MAP]

    master, slave = pty.openpty()
    proc = subprocess.Popen(
        cmd, cwd=PROJECT_DIR, stdin=slave, stdout=slave, stderr=slave, close_fds=True
    )
    os.close(slave)

    start = time.time()
    while proc.poll() is None and time.time() - start < 120:
        r, _, _ = select.select([master], [], [], 0.3)
        if r:
            try:
                chunk = os.read(master, 4096)
                # Respond to terminal capability queries so CLI doesn't hang
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
            except OSError:
                break

    if proc.poll() is None:
        proc.kill()
        try:
            os.close(master)
        except Exception:
            pass
        return False

    try:
        os.close(master)
    except Exception:
        pass
    return proc.returncode == 0


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
