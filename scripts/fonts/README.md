# Bundled CJK web fonts

`sources.json` pins the original release, source SHA-256, display name and CSS family for each font.

Install `fonttools[woff]==4.68.0` in a separate Python environment. Download each original source and the corresponding upstream license into a directory, then run:

```powershell
python scripts/fonts/build-cjk-fonts.py --source-dir <source-directory>
```

The generator refuses to overwrite an existing set of WOFF2 files. Generate in a clean checkout when upgrading a font. Review the source checksum and licenses before updating pins. Run the repository's underlying Prettier CLI on generated TypeScript/JSON/README files; preserve license files verbatim.

GB and TC use upstream OFL web-delivery permissions. The IPA-derived serif and sans fonts retain copyrights and use distinct web family/file names. Their picker labels identify the upstream glyph design in Traditional Chinese, as requested by the product owner. Source and replacement instructions live beside each generated font.

Each font directory includes a `manifest.json` recording Unicode coverage, original metrics and every web subset checksum. Adding a future font requires a new stable family ID, a `displayName` in the font's own script, registration, metrics, licensed assets and export checks. `Calileon ` is added by the picker label helper; display names are never translated by the UI locale.
