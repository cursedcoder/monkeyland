import type { Components } from "react-markdown";

/**
 * Open links in a new tab so the app isn't replaced when the user clicks.
 * Prevents monkeyland from being navigated away when agent replies contain URLs.
 */
export const markdownLinkComponents: Components = {
  a: ({ href, children, node: _node, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
};
