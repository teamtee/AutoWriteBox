export function createClientAbortTracker(req, res) {
  const controller = new AbortController();
  const markClientGone = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error('CLIENT_ABORTED'));
    }
  };
  req.once('aborted', markClientGone);
  res.once('close', markClientGone);
  const assertAlive = () => {
    if (controller.signal.aborted || req.aborted || res.destroyed) {
      throw new Error('CLIENT_ABORTED');
    }
  };
  return {
    signal: controller.signal,
    assertAlive,
    async assertAliveAfterIo() {
      // 给 socket 的 aborted/close 事件一次机会，在注册令牌或提交响应前识别断连。
      await new Promise((resolve) => setImmediate(resolve));
      assertAlive();
    },
    dispose() {
      req.removeListener('aborted', markClientGone);
      res.removeListener('close', markClientGone);
    },
  };
}
