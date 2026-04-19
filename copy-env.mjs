import * as fs from 'node:fs';
import * as path from 'node:path';

async function copyEnvFile(targetDir) {
  try {
    targetDir = targetDir.trim();

    const examplePath = path.join(targetDir, '.env.example');
    const envPath = path.join(targetDir, '.env');

    console.log('Attempting to copy from:', examplePath);
    console.log('To:', envPath);

    try {
      await fs.promises.access(examplePath, fs.constants.F_OK);
    } catch {
      console.log(`.env.example file does not exist in ${targetDir}, skipping env setup.`);
      return;
    }

    try {
      await fs.promises.access(envPath, fs.constants.F_OK);
      console.log(`.env file already exists in ${targetDir}, no action taken.`);
    } catch {
      try {
        await fs.promises.copyFile(examplePath, envPath);
        console.log(`.env.example has been copied to ${envPath}`);
      } catch (copyErr) {
        console.error('Error occurred copying file:', copyErr.message);
        process.exit(1);
      }
    }
  } catch (error) {
    console.error('Unexpected error:', error);
    process.exit(1);
  }
}

const directoryPath = process.argv[2]?.trim();

if (directoryPath) {
  copyEnvFile(directoryPath).catch((error) => {
    console.error('Failed to copy env file:', error);
    process.exit(1);
  });
} else {
  console.error('Please provide a directory path as an argument.');
  process.exit(1);
}
