export async function startTestServer(app) {
  let server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server = app.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
    server.once('error', onError);
  });
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

export async function stopTestServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    // Node fetch 默认复用 keep-alive 连接；测试结束时强制释放，避免后续文件挂起。
    server.closeAllConnections?.();
  });
}
