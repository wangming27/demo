import { memo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

const plugins = [remarkGfm];
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => (
    <a href={src} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {alt || '查看图片'}
    </a>
  ),
  table: ({ children }) => (
    <div className="chat-markdown-table">
      <table>{children}</table>
    </div>
  ),
};

export default memo(function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-markdown">
      <Markdown remarkPlugins={plugins} components={components} skipHtml>
        {content}
      </Markdown>
    </div>
  );
});
