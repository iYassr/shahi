"""Bounded snapshots of demo data; never follow links or restore special files."""
import io, os, pathlib, sqlite3, sys, tarfile, tempfile
HOME = pathlib.Path('/home/demo')
DB = HOME / '.local/share/shahi/shahi.sqlite'
LIMIT = 32 * 1024 * 1024
ROOTS = ('.local/share/shahi/uploads', 'workspace', '.config/herdr', '.codex/sessions', '.claude/projects')

def permitted(name):
    p = pathlib.PurePosixPath(name)
    return not p.is_absolute() and '..' not in p.parts and (name == '.local/share/shahi/shahi.sqlite' or any(name == root or name.startswith(root + '/') for root in ROOTS))

if sys.argv[1] == 'save':
    temp = tempfile.TemporaryDirectory(prefix='shahi-snapshot-')
    snapshot = temp.name + '/snapshot.sqlite'
    with sqlite3.connect(str(DB)) as source, sqlite3.connect(snapshot) as dest:
        source.backup(dest)
    total = 0
    with tarfile.open(fileobj=sys.stdout.buffer, mode='w|gz', dereference=False) as tar:
        def add(path, name):
            global total
            if path.is_symlink() or not path.is_file(): return
            size = path.stat().st_size
            total += size
            if total > LIMIT: raise RuntimeError('Demo snapshot exceeds 32 MiB')
            tar.add(path, arcname=name, recursive=False)
        add(pathlib.Path(snapshot), '.local/share/shahi/shahi.sqlite')
        for root in ROOTS:
            base = HOME / root
            if base.is_symlink(): continue
            for parent, dirs, files in os.walk(base, followlinks=False):
                dirs[:] = [d for d in dirs if not (pathlib.Path(parent) / d).is_symlink()]
                for file in files:
                    p = pathlib.Path(parent) / file
                    if file.endswith(('.log', '.sock')): continue
                    add(p, str(p.relative_to(HOME)))
elif sys.argv[1] == 'restore':
    total = 0
    with tarfile.open(sys.argv[2], 'r:gz') as tar:
        members = tar.getmembers()
        for m in members:
            if not permitted(m.name) or not m.isfile(): raise RuntimeError('Unsafe snapshot entry')
            total += m.size
            if total > LIMIT: raise RuntimeError('Snapshot exceeds 32 MiB')
        for m in members:
            target = HOME / m.name
            target.parent.mkdir(parents=True, exist_ok=True)
            # Fresh image plus regular-file-only archive: no symlink traversal.
            if any(p.is_symlink() for p in (target, *target.parents)): raise RuntimeError('Snapshot link')
            with tar.extractfile(m) as src, open(target, 'wb') as out: out.write(src.read())
            os.chmod(target, 0o600)
            os.chown(target, 1001, 1001)
    for parent, dirs, files in os.walk(HOME):
        os.chown(parent, 1001, 1001)
else:
    raise RuntimeError('Unknown command')
