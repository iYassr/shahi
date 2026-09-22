import io, pathlib, subprocess, tarfile, tempfile, unittest

STATE = pathlib.Path(__file__).with_name('state.py')

class SnapshotTests(unittest.TestCase):
    def rejected(self, member):
        with tempfile.NamedTemporaryFile(suffix='.tar.gz') as archive:
            with tarfile.open(archive.name, 'w:gz') as tar:
                tar.addfile(member, io.BytesIO(b'x' * member.size) if member.isfile() else None)
            result = subprocess.run(['python3', str(STATE), 'restore', archive.name], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
    def test_traversal_rejected(self):
        entry=tarfile.TarInfo('../outside'); entry.size=1; self.rejected(entry)
    def test_absolute_rejected(self):
        entry=tarfile.TarInfo('/etc/passwd'); entry.size=1; self.rejected(entry)
    def test_symlink_rejected(self):
        entry=tarfile.TarInfo('workspace/link'); entry.type=tarfile.SYMTYPE; entry.linkname='/run/shahi'; self.rejected(entry)
    def test_unlisted_location_rejected(self):
        entry=tarfile.TarInfo('.ssh/authorized_keys'); entry.size=1; self.rejected(entry)

if __name__ == '__main__': unittest.main()
