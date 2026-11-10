"""Version and package the native Dispatch application using only Python's standard library."""

import argparse
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PLATFORMS = ("linux-x64", "win-x64", "macos-x64", "macos-arm64")
NUMERIC = r"(?:0|[1-9][0-9]*)"
IDENTIFIER = r"(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
SEMVER = re.compile(
    rf"{NUMERIC}\.{NUMERIC}\.{NUMERIC}"
    rf"(?:-{IDENTIFIER}(?:\.{IDENTIFIER})*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)


def release_version(tag):
    version = tag.removeprefix("v")
    if not SEMVER.fullmatch(version):
        raise ValueError("Release tags must be semantic versions, such as v1.2.3 or v1.2.3-beta.1.")
    return version


def set_version(root, tag):
    version = release_version(tag)
    manifest = root / "Cargo.toml"
    lockfile = root / "Cargo.lock"
    manifest_text = manifest.read_text(encoding="utf-8")
    name = tomllib.loads(manifest_text)["package"]["name"]
    lock_text = lockfile.read_text(encoding="utf-8")
    manifest_text, manifest_count = re.subn(
        r'(?ms)(^\[package\]\n.*?^version\s*=\s*)"[^"\n]+"',
        lambda match: f'{match[1]}"{version}"', manifest_text, count=1,
    )
    lock_text, lock_count = re.subn(
        rf'(?m)(^\[\[package\]\]\nname = "{re.escape(name)}"\nversion = )"[^"\n]+"',
        lambda match: f'{match[1]}"{version}"', lock_text, count=1,
    )
    if manifest_count != 1 or lock_count != 1:
        raise ValueError("Could not locate the application version in Cargo.toml and Cargo.lock.")
    manifest.write_text(manifest_text, encoding="utf-8")
    lockfile.write_text(lock_text, encoding="utf-8")
    return version


def copy_resources(root, destination):
    destination.mkdir(parents=True, exist_ok=True)
    for source, name in [
        ("LICENSE", "LICENSE"),
        ("LICENSE-APACHE", "LICENSE-APACHE"),
        ("THIRD_PARTY.md", "THIRD_PARTY.md"),
        ("assets/fonts/OFL.txt", "OFL.txt"),
        ("README.md", "README.md"),
    ]:
        shutil.copyfile(root / source, destination / name)


def package(root, binary, platform, version, output):
    version = release_version(version)
    if platform not in PLATFORMS:
        raise ValueError(f"Unsupported release platform: {platform}")
    if not binary.is_file():
        raise FileNotFoundError(f"Native executable not found: {binary}")
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="dispatch-release-") as temporary:
        staging = Path(temporary)
        if platform.startswith("macos-"):
            bundle = staging / "Dispatch.app"
            contents = bundle / "Contents"
            executable = contents / "MacOS/dispatch"
            executable.parent.mkdir(parents=True)
            copy_resources(root, contents / "Resources")
            core_version = version.split("-", 1)[0].split("+", 1)[0]
            with (contents / "Info.plist").open("wb") as info:
                plistlib.dump({
                    "CFBundleName": "Dispatch",
                    "CFBundleDisplayName": "Dispatch",
                    "CFBundleIdentifier": "org.dispatchworkflows.dispatch",
                    "CFBundleExecutable": "dispatch",
                    "CFBundlePackageType": "APPL",
                    "CFBundleShortVersionString": core_version,
                    "CFBundleVersion": core_version,
                    "CFBundleGetInfoString": f"Dispatch {version}",
                    "LSMinimumSystemVersion": "13.0",
                    "NSHighResolutionCapable": True,
                }, info)
        else:
            bundle = staging / "Dispatch"
            copy_resources(root, bundle)
            executable = bundle / ("dispatch.exe" if platform == "win-x64" else "dispatch")
            if platform == "linux-x64":
                for name in ("dispatch-workflows.desktop", "dispatch-workflows.svg"):
                    shutil.copyfile(root / "arch" / name, bundle / name)
        shutil.copyfile(binary, executable)
        executable.chmod(0o755)
        if platform.startswith("macos-"):
            subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(bundle)], check=True)
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundle)], check=True)
        extension = "zip" if platform == "win-x64" else "tar.gz"
        archive = output / f"dispatch-workflows-{version}-{platform}.{extension}"
        if extension == "zip":
            with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as release:
                for file in sorted(bundle.rglob("*")):
                    if file.is_file():
                        release.write(file, file.relative_to(staging).as_posix())
        else:
            with tarfile.open(archive, "w:gz") as release:
                executable_name = executable.relative_to(staging).as_posix()

                def archive_metadata(info):
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mode = 0o755 if info.isdir() or info.name == executable_name else 0o644
                    return info

                release.add(bundle, arcname=bundle.name, filter=archive_metadata)
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    commands = parser.add_subparsers(dest="command", required=True)
    version_command = commands.add_parser("set-version")
    version_command.add_argument("tag")
    package_command = commands.add_parser("package")
    package_command.add_argument("--platform", choices=PLATFORMS, required=True)
    package_command.add_argument("--version", required=True)
    package_command.add_argument("--binary", type=Path, required=True)
    package_command.add_argument("--output", type=Path, default=ROOT / "dist")
    args = parser.parse_args()
    if args.command == "set-version":
        version = set_version(args.root, args.tag)
        if os.environ.get("GITHUB_ENV"):
            with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as environment:
                environment.write(f"DISPATCH_VERSION={version}\n")
        print(version)
    else:
        print(package(args.root, args.binary, args.platform, args.version, args.output))


if __name__ == "__main__":
    main()
