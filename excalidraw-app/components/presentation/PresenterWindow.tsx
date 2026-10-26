import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";

const COPIED_ATTR = "data-calileon-presenter-copy";

const copyStyleNode = (node: Node, target: Document) => {
  if (node instanceof HTMLStyleElement) {
    const copy = target.createElement("style");
    copy.setAttribute(COPIED_ATTR, "");
    copy.textContent = node.textContent;
    target.head.appendChild(copy);
  } else if (node instanceof HTMLLinkElement && node.rel === "stylesheet") {
    const copy = target.createElement("link");
    copy.setAttribute(COPIED_ATTR, "");
    copy.rel = "stylesheet";
    // absolute: the popup is about:blank
    copy.href = node.href;
    target.head.appendChild(copy);
  }
};

/**
 * Renders `children` into a same-origin popup (ADR 0036 §4): both windows
 * share one React tree and one slideshow state, so no message protocol is
 * needed. The opener's stylesheets are copied (and new ones mirrored) so the
 * app tokens and primitives look the same.
 */
export const PresenterWindow = ({
  popup,
  title,
  className,
  lang,
  onClosed,
  onKeyDown,
  children,
}: {
  popup: Window;
  title: string;
  className: string;
  lang: string;
  onClosed: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  children: React.ReactNode;
}) => {
  const [root, setRoot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    let doc: Document;
    try {
      doc = popup.document;
    } catch {
      // not ours any more (navigated away)
      onClosed();
      return;
    }
    // a reused named window may still hold a previous session's nodes
    doc.querySelectorAll(`[${COPIED_ATTR}]`).forEach((node) => node.remove());
    doc.body.replaceChildren();
    document.head
      .querySelectorAll("style, link[rel=stylesheet]")
      .forEach((node) => copyStyleNode(node, doc));
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => copyStyleNode(node, doc));
      }
    });
    observer.observe(document.head, { childList: true });

    doc.documentElement.style.height = "100%";
    doc.body.style.height = "100%";
    doc.body.style.margin = "0";
    const container = doc.createElement("div");
    container.setAttribute(COPIED_ATTR, "");
    container.style.height = "100%";
    doc.body.appendChild(container);
    setRoot(container);

    return () => {
      observer.disconnect();
      container.remove();
      setRoot(null);
    };
  }, [popup, onClosed]);

  useEffect(() => {
    try {
      popup.document.title = title;
      popup.document.documentElement.lang = lang;
    } catch {
      // closed in between
    }
  }, [popup, title, lang]);

  useEffect(() => {
    if (root) {
      root.className = className;
    }
  }, [root, className]);

  useEffect(() => {
    // `closed` is the only signal that survives every browser's popup UI
    const timer = window.setInterval(() => {
      if (popup.closed) {
        onClosed();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [popup, onClosed]);

  useEffect(() => {
    try {
      popup.addEventListener("keydown", onKeyDown);
      return () => popup.removeEventListener("keydown", onKeyDown);
    } catch {
      return undefined;
    }
  }, [popup, onKeyDown]);

  return root ? createPortal(children, root) : null;
};
