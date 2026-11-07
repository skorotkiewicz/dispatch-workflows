import importlib.util
from pathlib import Path
import plistlib
import shutil
import tarfile
import tempfile
import tomllib
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("dispatch_release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="dispatch-release-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.native = self.root / "dispatch-rs"
        self.native.mkdir()
        self.manifest = self.native / "Cargo.toml"
        self.lock = self.native / "Cargo.lock"
        self.manifest.write_text('[package]\nname = "dispatch-rs"\nversion = "0.1.0"\n\n[dependencies]\nanyhow = "1"\n', encoding="utf-8")
        self.lock.write_text('version = 4\n\n[[package]]\nname = "anyhow"\nversion = "1.0.0"\n\n[[package]]\nname = "dispatch-rs"\nversion = "0.1.0"\ndependencies = ["anyhow"]\n', encoding="utf-8")

    def stage_resources(self):
        for name in ("arch/LICENSE", "arch/dispatch-workflows.desktop", "arch/dispatch-workflows.svg", "README.md",
                     "dispatch-rs/LICENSE-APACHE", "dispatch-rs/THIRD_PARTY.md", "dispatch-rs/assets/fonts/OFL.txt"):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(release.ROOT / name, destination)
        binary = self.root / "native-binary"
        binary.write_bytes(b"native executable fixture")
        return binary

    def test_tag_updates_application_and_lock_without_changing_dependencies(self):
        self.assertEqual(release.set_version(self.root, "v2.3.4-beta.1+build.7"), "2.3.4-beta.1+build.7")
        self.assertEqual(tomllib.loads(self.manifest.read_text())["package"]["version"], "2.3.4-beta.1+build.7")
        entries = tomllib.loads(self.lock.read_text())["package"]
        self.assertEqual(entries[0]["version"], "1.0.0")
        self.assertEqual(entries[1]["version"], "2.3.4-beta.1+build.7")
        self.assertEqual(entries[1]["dependencies"], ["anyhow"])

    def test_invalid_tags_do_not_modify_files(self):
        original = self.manifest.read_bytes(), self.lock.read_bytes()
        for tag in ("latest", "v01.2.3", "v1.2", "v1.2.3-01", "v1.2.3\nINJECT=value", "../1.2.3"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.set_version(self.root, tag)
            self.assertEqual((self.manifest.read_bytes(), self.lock.read_bytes()), original)

    def test_missing_application_lock_entry_does_not_modify_manifest(self):
        original = self.manifest.read_bytes()
        self.lock.write_text('version = 4\n', encoding="utf-8")
        with self.assertRaises(ValueError):
            release.set_version(self.root, "v1.2.3")
        self.assertEqual(self.manifest.read_bytes(), original)

    def test_linux_archive_matches_pkgbuild_payload(self):
        binary = self.stage_resources()
        archive = release.package(self.root, binary, "linux-x64", "1.2.3", self.root / "dist")
        self.assertEqual(archive.name, "dispatch-workflows-1.2.3-linux-x64.tar.gz")
        with tarfile.open(archive) as package:
            names = set(package.getnames())
            for name in ("dispatch", "dispatch-workflows.desktop", "dispatch-workflows.svg", "LICENSE", "LICENSE-APACHE", "OFL.txt", "THIRD_PARTY.md"):
                self.assertIn(f"Dispatch/{name}", names)
            self.assertEqual(package.extractfile("Dispatch/dispatch").read(), binary.read_bytes())
            self.assertEqual(package.getmember("Dispatch/dispatch").mode, 0o755)
            self.assertFalse(any("node_modules" in name or "Resources/app" in name for name in names))

    def test_windows_archive_contains_executable_and_licenses(self):
        binary = self.stage_resources()
        archive = release.package(self.root, binary, "win-x64", "1.2.3", self.root / "dist")
        with zipfile.ZipFile(archive) as package:
            self.assertEqual(package.read("Dispatch/dispatch.exe"), binary.read_bytes())
            self.assertIn("Dispatch/OFL.txt", package.namelist())
            self.assertNotIn("Dispatch/dispatch-workflows.desktop", package.namelist())

    def test_macos_bundles_are_versioned_and_signed_before_archiving(self):
        binary = self.stage_resources()
        for platform in ("macos-x64", "macos-arm64"):
            with self.subTest(platform=platform), patch.object(release.subprocess, "run") as codesign:
                archive = release.package(self.root, binary, platform, "1.2.3-beta.1", self.root / "dist")
                self.assertEqual(codesign.call_count, 2)
                self.assertEqual(codesign.call_args_list[0].args[0][:5], ["codesign", "--force", "--deep", "--sign", "-"])
                self.assertIn("--verify", codesign.call_args_list[1].args[0])
                with tarfile.open(archive) as package:
                    info = plistlib.loads(package.extractfile("Dispatch.app/Contents/Info.plist").read())
                    self.assertEqual(info["CFBundleExecutable"], "dispatch")
                    self.assertEqual(info["CFBundleShortVersionString"], "1.2.3")
                    self.assertEqual(info["CFBundleGetInfoString"], "Dispatch 1.2.3-beta.1")
                    self.assertEqual(package.extractfile("Dispatch.app/Contents/MacOS/dispatch").read(), binary.read_bytes())
                    self.assertIn("Dispatch.app/Contents/Resources/LICENSE-APACHE", package.getnames())


if __name__ == "__main__":
    unittest.main()
