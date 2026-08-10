import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  isSupportedWritingAssetFile, MAX_WRITING_ASSET_FILE_BYTES,
  readWritingAssetFile, WritingAssetPanel,
} from './WritingAssetPanel';

function fakeFile({ name = 'sample.txt', type = 'text/plain', bytes }: {
  name?: string; type?: string; bytes: Uint8Array;
}) {
  return {
    name, type, size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength,
    ),
  } as File;
}

describe('WritingAssetPanel imports', () => {
  it('renders paste, document import, authorization and privacy guidance', () => {
    const html = renderToStaticMarkup(
      <WritingAssetPanel bookId="book_test" onApplyStyle={() => true} />,
    );
    expect(html).toContain('创作资产库');
    expect(html).toContain('一键提取资产');
    expect(html).toContain('导入文档');
    expect(html).toContain('用户原创');
    expect(html).toContain('本人旧作');
    expect(html).toContain('仅登记链接');
    expect(html).toContain('作品/章节备注');
    expect(html).toContain('权利说明');
    expect(html).toContain('适用题材');
    expect(html).toContain('场景标签');
    expect(html).toContain('参考链接');
    expect(html).toContain('不保存全文');
  });

  it('accepts text/markdown extensions and rejects unrelated formats', () => {
    expect(isSupportedWritingAssetFile({ name: 'chapter.TXT', type: '' })).toBe(true);
    expect(isSupportedWritingAssetFile({ name: 'notes.markdown', type: '' })).toBe(true);
    expect(isSupportedWritingAssetFile({ name: 'book.docx', type: '' })).toBe(false);
  });

  it('reads UTF-8 text, strips BOM and rejects invalid UTF-8', async () => {
    const valid = fakeFile({
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('正文')]),
    });
    await expect(readWritingAssetFile(valid)).resolves.toBe('正文');
    const invalid = fakeFile({ bytes: new Uint8Array([0xc3, 0x28]) });
    await expect(readWritingAssetFile(invalid)).rejects.toThrow('不是有效的 UTF-8');
  });

  it('rejects empty and oversized files before allocating decoded text', async () => {
    await expect(readWritingAssetFile(fakeFile({ bytes: new Uint8Array() })))
      .rejects.toThrow('文件为空');
    const oversized = fakeFile({ bytes: new Uint8Array(MAX_WRITING_ASSET_FILE_BYTES + 1) });
    await expect(readWritingAssetFile(oversized)).rejects.toThrow('超过 512 KB');
  });
});
