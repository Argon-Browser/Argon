"""Branding package contract tests.

These validate the asset inventory Argon's Linux branding system requires, the
declared pixel dimensions, PNG structure, and that the Argon name and
vendor strings are independent of Mozilla's trademarks. Stdlib only: PNG
headers are parsed directly so the suite does not need Pillow.
"""

from __future__ import annotations

import re
import struct
import unittest
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[2]
BRANDING = ROOT / "browser" / "branding" / "argon"
CONTENT = BRANDING / "content" / "branding"
LOCALES = BRANDING / "locales" / "en-US"
BRAND_KIT = ROOT / "brand-kit"

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"

REQUIRED_ICONS = {16, 32, 48, 64, 128}
REQUIRED_CONTENT = [
    "about.png", "about-logo.png", "about-logo.svg", "about-logo@2x.png",
    "about-wordmark.svg", "about-logo-private.png", "about-logo-private@2x.png",
    "document_pdf.svg", "firefox-wordmark.svg", "aboutDialog.css",
]
REQUIRED_BUILD_FILES = [
    "moz.build", "configure.sh", "content/moz.build", "content/jar.mn",
    "locales/moz.build", "locales/jar.mn", "locales/en-US/brand.ftl",
    "locales/en-US/brand.properties", "pref/firefox-branding.js",
]


def png_size(path: Path) -> tuple[int, int]:
    header = path.read_bytes()[:24]
    assert header[:8] == PNG_MAGIC, f"{path} is not a PNG"
    width, height = struct.unpack(">II", header[16:24])
    return width, height


class BrandingAssetTests(unittest.TestCase):
    def test_application_icons_exist_at_the_exact_required_sizes(self):
        for size in REQUIRED_ICONS:
            path = BRANDING / f"default{size}.png"
            self.assertTrue(path.is_file(), f"missing {path.name}")
            self.assertEqual(png_size(path), (size, size), f"{path.name} must be exactly {size}x{size}")

    def test_content_assets_exist(self):
        for name in REQUIRED_CONTENT:
            self.assertTrue((CONTENT / name).is_file(), f"missing content/branding/{name}")

    def test_build_integration_files_exist(self):
        for name in REQUIRED_BUILD_FILES:
            self.assertTrue((BRANDING / name).is_file(), f"missing {name}")

    def test_every_jar_entry_points_at_a_real_file(self):
        jar_dir = BRANDING / "content"
        jar = (jar_dir / "jar.mn").read_text(encoding="utf-8")
        entries = [line.strip() for line in jar.splitlines()
                   if line.startswith("  content/branding/")]
        self.assertTrue(entries, "jar.mn must list branding content entries")
        for line in entries:
            match = re.fullmatch(r"(\S+)(?:\s+\(([^)]+)\))?", line)
            self.assertIsNotNone(match, f"malformed jar.mn entry: {line}")
            output, source = match.group(1), match.group(2)
            # JarManifestParser resolves an omitted source as basename(output)
            # relative to the directory holding jar.mn.
            rel_source = source or output.rsplit("/", 1)[-1]
            resolved = (jar_dir / rel_source).resolve()
            self.assertTrue(resolved.is_file(),
                            f"jar.mn entry {output} points at missing {jar_dir / rel_source}")

    def test_branding_strings_use_the_argon_name_and_no_mozilla_marks(self):
        ftl = (LOCALES / "brand.ftl").read_text(encoding="utf-8")
        props = (LOCALES / "brand.properties").read_text(encoding="utf-8")
        combined = f"{ftl}\n{props}"
        self.assertIn("-brand-short-name = Argon", ftl)
        self.assertIn("brandShortName=Argon", props)
        self.assertNotIn("Firefox", combined.replace("brand-product-name", ""))
        self.assertNotIn("Mozilla", combined)

    def test_branding_prefs_do_not_advertise_a_production_update_server(self):
        prefs = (BRANDING / "pref" / "firefox-branding.js").read_text(encoding="utf-8")
        urls = re.findall(r'"(https?://[^"]+)"', prefs)
        for url in urls:
            self.assertNotRegex(url, r"mozilla\.org|firefox\.com",
                                "branding prefs must not point at Mozilla update endpoints")

    def test_configure_sets_an_independent_display_name(self):
        configure = (BRANDING / "configure.sh").read_text(encoding="utf-8")
        self.assertIn("MOZ_APP_DISPLAYNAME=Argon", configure)
        self.assertNotIn("MOZ_MACBUNDLE_ID", configure)

    def test_identity_sources_are_original_svg(self):
        for name in ("about-logo.svg", "about-wordmark.svg", "document_pdf.svg"):
            svg = (CONTENT / name).read_text(encoding="utf-8")
            self.assertIn("<svg", svg, f"{name} must be SVG")
            self.assertNotIn("firefox", svg.lower(), f"{name} must not embed Firefox marks")
            self.assertNotIn("mozilla", svg.lower(), f"{name} must not embed Mozilla marks")
        logo = (CONTENT / "about-logo.svg").read_text(encoding="utf-8")
        self.assertIn("#1E1E1E", logo, "primary mark must use the Obsidian container colour")
        self.assertIn("#FBF8F4", logo, "primary mark must use the Ivory glyph colour")

    def test_new_tab_wordmark_is_text_only_and_inherits_the_page_color(self):
        """New Tab supplies a separate 64 px logo and the contrasting fill."""
        svg = ElementTree.fromstring((CONTENT / "firefox-wordmark.svg").read_text())
        namespace = {"svg": "http://www.w3.org/2000/svg"}
        self.assertFalse(svg.findall(".//svg:rect", namespace),
                         "The wordmark must not duplicate the standalone logo")
        text = svg.find("svg:text", namespace)
        self.assertIsNotNone(text)
        assert text is not None
        self.assertEqual(text.text, "Argon")
        self.assertEqual(text.get("fill"), "context-fill",
                         "Hardcoded Ivory disappears against a light New Tab background")
        _, _, width, height = map(float, svg.attrib["viewBox"].split())
        self.assertLessEqual(width / height, 4,
                             "The wordmark must fill its native 105 px background, not shrink a lockup")

    def test_brand_kit_assets_and_tokens_exist(self):
        for name in (
            "argon-brand-sheet.png",
            "mark-primary.svg",
            "mark-inverted.svg",
            "mark-private.svg",
            "glyph-ivory.svg",
            "glyph-obsidian.svg",
            "lockup-dark.svg",
            "lockup-light.svg",
            "construction-grid.svg",
            "brand-tokens.json",
            "mark-primary-512.png",
            "mark-inverted-512.png",
            "mark-private-512.png",
        ):
            self.assertTrue((BRAND_KIT / name).is_file(), f"missing brand-kit/{name}")
        self.assertEqual(png_size(BRAND_KIT / "mark-primary-512.png"), (512, 512))
        self.assertEqual(png_size(BRAND_KIT / "argon-brand-sheet.png"), (1600, 1100))


if __name__ == "__main__":
    unittest.main(verbosity=2)
