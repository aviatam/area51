// Compatibility entry point for older automation. Security is now native.
if (process.argv.includes('--remove')) {
  throw new Error(
    'Dependency security is built into Area51. Stop the host and use a reviewed version rollback; this command cannot disable live protection.',
  );
}
console.log('Dependency security is built in. Normal agent startup provisions the pinned scanner automatically.');
