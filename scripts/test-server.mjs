if (process.env.NODE_ENV === 'test') {
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.includes('\n')) process.emit('SIGTERM');
  });
}

await import('../server.js');
