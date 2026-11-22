"""Build a direct-upload ZIP for the browser-free Lambda (after npm ci)."""
from pathlib import Path
from tempfile import mkdtemp
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
modules = root / 'node_modules'
if not (modules / '@aws-sdk/client-dynamodb/package.json').is_file():
    raise SystemExit('Run npm ci first')
artifacts = root / 'artifacts'
artifacts.mkdir(exist_ok=True)
out = Path(mkdtemp(prefix='lambda-http-', dir=artifacts)) / 'function.zip'
with ZipFile(out, 'x', ZIP_DEFLATED) as archive:
    archive.writestr('index.cjs', 'exports.handler = (...a) => import("./src/lambda.js").then(m => m.handler(...a));\n')
    archive.write(root / 'package.json', 'package.json')
    for name in ('lambda', 'monitor-http', 'alerts', 'config', 'constants', 'helpers'):
        archive.write(root / f'src/{name}.js', f'src/{name}.js')
    for package in modules.iterdir():
        if package.name.startswith('.') or package.name in {'playwright', 'playwright-core', '@sparticuz'}:
            continue
        for file in package.rglob('*'):
            if file.is_file() and not file.is_symlink():
                archive.write(file, file.relative_to(root))
if out.stat().st_size >= 50 * 1024**2:
    raise SystemExit('ZIP exceeds the direct-upload limit')
print(f'{out}: {out.stat().st_size / 1024**2:.2f} MiB')
