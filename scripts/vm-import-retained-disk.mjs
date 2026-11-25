import {readPlain} from './lib/vm-import-stage.mjs';
import {importToRetainedDisk} from './lib/vm-disk-import.mjs';

try {
  if (process.argv.length !== 3) throw Error('disk_import_config_required');
  const config = JSON.parse(await readPlain(process.argv[2], 65536));
  console.log(JSON.stringify(await importToRetainedDisk(config)));
} catch (error) {
  const reason = error.code === 'ENOSPC' ? 'disk_import_out_of_space' :
    /^(disk_import_|merge_|import_tree_|import_stage_)[a-z_]+$/.test(error.message)
      ? error.message : 'disk_import_input_or_io_error';
  console.error(JSON.stringify({status: 'blocked', reason}));
  process.exitCode = 1;
}
