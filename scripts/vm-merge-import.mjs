import {readPlain} from './lib/vm-import-stage.mjs';
import {assembleMergedImport} from './lib/vm-import-merge.mjs';

try {
  if (process.argv.length !== 3) throw Error('merge_config_required');
  const config = JSON.parse(await readPlain(process.argv[2], 65536));
  const receipt = await assembleMergedImport(config);
  console.log(JSON.stringify(receipt));
} catch (error) {
  const message = /^(merge_|import_tree_|import_stage_)[a-z_]+$/.test(error.message)
    ? error.message : 'merge_input_or_io_error';
  console.error(JSON.stringify({status: 'blocked', reason: message}));
  process.exitCode = 1;
}
