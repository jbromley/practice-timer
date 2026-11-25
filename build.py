from pathlib import Path
from shutil import copy2
from tempfile import TemporaryDirectory
import zipapp

import app


def main():
    output = app.ROOT / "practice-timer.pyz"
    with TemporaryDirectory() as temp:
        staging = Path(temp)
        files = [Path("app.py"), app.SCHEMA.relative_to(app.ROOT)]
        files.extend(Path("static") / filename for filename, _ in app.ASSETS.values())
        for filename in files:
            destination = staging / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            copy2(app.ROOT / filename, destination)
        zipapp.create_archive(
            staging, output, interpreter="/usr/bin/env python3", main="app:main", compressed=True,
        )
    print(output)


if __name__ == "__main__":
    main()
