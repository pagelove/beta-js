import { DOMSubscriber } from "https://cdn.pagelove.net/js/dom-subscriber/cde4007/index.mjs";
import { Pagelove as Debug } from "./debug.mjs";

/**
 * Generate a stable CSS selector for an element.
 * Prefers IDs > itemprop > class names > nth-child (last resort).
 */
function stableStepSelector(el, parent) {
  const tag = el.tagName.toLowerCase();

  /* Try itemprop — very stable for microdata elements */
  const itemprop = el.getAttribute("itemprop");
  if (itemprop) {
    const sel = `[itemprop="${CSS.escape(itemprop)}"]`;
    try {
      if (parent.querySelectorAll(`:scope > ${sel}`).length === 1) return sel;
    } catch (e) {}
    const tagSel = `${tag}${sel}`;
    try {
      if (parent.querySelectorAll(`:scope > ${tagSel}`).length === 1)
        return tagSel;
    } catch (e) {}
  }

  /* Fallback: nth-child */
  const index = parent.children ? [].indexOf.call(parent.children, el) + 1 : 1;
  return `${tag}:nth-child(${index})`;
}

function generateSelector() {
  try {
    /* If element has an ID, use it directly */
    if (this.id) {
      return `#${CSS.escape(this.id)}`;
    }

    let el = this;
    let path = [];

    while (el.parentNode) {
      const parent = el.parentNode;
      if (parent.nodeType !== Node.ELEMENT_NODE && parent !== document) break;

      /* If parent has an ID, anchor the selector from there */
      if (parent.id) {
        path.unshift(stableStepSelector(el, parent));
        return `#${CSS.escape(parent.id)} > ${path.join(" > ")}`;
      }

      path.unshift(stableStepSelector(el, parent));
      el = parent;
    }

    return path.join(" > ");
    f;
  } catch (error) {
    Debug.error(
      Debug.PRIMITIVES,
      "[PLPrimitives] Failed to generate selector:",
      error,
    );
    return `${this.tagName || "unknown"}`.toLowerCase();
  }
}

/**
 * Serialize a Node for sending in a POST/PUT body, stripping client-side
 * bookkeeping attributes (data-pl-*, contenteditable injected for inline
 * editing) so the wire format only carries semantic microdata.
 *
 * The original node is left untouched.
 */
function serializeForRequest(node) {
  if (node.nodeType !== 1) return node.outerHTML ?? node.nodeValue ?? "";
  const clone = node.cloneNode(true);
  const strip = (el) => {
    // Remove client-side transient attributes
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("data-pl-")) el.removeAttribute(attr.name);
    }
    // contenteditable is wired up at runtime by pagelove's PLCapability
    // handler; the source-of-truth is the schema, not whether the field
    // is currently editable in this session.
    if (el.hasAttribute("contenteditable"))
      el.removeAttribute("contenteditable");
    for (const child of el.children) strip(child);
  };
  strip(clone);
  return clone.outerHTML;
}

function htmlToNode(html) {
  try {
    const template = document.createElement("template");
    template.innerHTML = html.trim();
    const nNodes = template.content.childNodes.length;
    if (nNodes !== 1) {
      throw new Error(
        `html parameter must represent a single node; got ${nNodes}.`,
      );
    }
    return template.content.firstChild;
  } catch (error) {
    Debug.error(
      Debug.PRIMITIVES,
      "[PLPrimitives] Failed to parse HTML:",
      error,
    );
    throw error;
  }
}

class MultipartBody {
  constructor(rawBody, boundary) {
    this.parts = [];
    const delimiter = `--${boundary}`;
    const sections = rawBody
      .split(delimiter)
      .filter((section) => section.trim() && section.trim() !== "--");
    for (const section of sections) {
      const [rawHeaders, ...bodyLines] = section.split("\r\n\r\n");
      const headers = {};
      for (const line of rawHeaders.trim().split("\r\n")) {
        const [key, value] = line.split(": ");
        headers[key.toLowerCase()] = value;
      }
      const body = bodyLines.join("\r\n\r\n").trim();
      this.parts.push({ headers, body });
    }
  }
}

class MultipartMessage {
  constructor(message) {
    if (!message.ok)
      throw new Error("HTTP Message not ok (status outside of 400-499 range)");
    if (!this.constructor.isMultipart(message)) {
      console.warn("HTTP Message is not multi-part");
      return null;
    }

    this.message = message;
  }

  get parts() {
    return (async () => {
      const text = await this.body;
      const body = new MultipartBody(text, this.boundary);
      return body.parts;
    })();
  }

  get body() {
    if (this.bodyText) {
      return (async () => {
        return this.bodyText;
      })();
    } else {
      return (async () => {
        const bodyText = await this.message.text();
        this.bodyText = bodyText;
        return this.bodyText;
      })();
    }
  }

  get boundary() {
    const contentType = this.message.headers.get("Content-Type") || "";
    const boundary = contentType.match(/boundary=(.+)$/);
    return boundary[1];
  }

  static isMultipart(message) {
    const contentType = message.headers.get("Content-Type") || "";
    if (contentType) return !!contentType.match(/boundary=(.+)$/);
    return false;
  }
}

async function OPTIONS(aPLDocument) {
  const message = new MultipartMessage(
    await fetch(aPLDocument.url, {
      method: "OPTIONS",
      headers: {
        Prefer: "return=representation",
        Accept: "multipart/mixed",
      },
    }),
  );
  if (message) {
    const parts = await message.parts;
    for (const part of parts) {
      if (part.headers["content-range"]) {
        // Content-Range carries the matched selector after the unit
        // token. Two server formats must BOTH work: the legacy
        // "selector=<css>" and the RFC-shaped "selector <css>" (unit +
        // SP + value, which the server now emits). Strip the "selector"
        // unit plus an optional "=" and surrounding whitespace; the
        // remainder is the CSS, which itself may contain '=', spaces,
        // brackets and quotes (e.g. [itemtype="urn:console:User"]).
        const cr = part.headers["content-range"].trim();
        const selector = cr.replace(/^selector\s*=?\s*/, "").trim();
        const doc = await aPLDocument.document;
        DOMSubscriber.subscribe(doc, selector, (node) => {
          const anEvent = new CustomEvent("PLCapability", {
            detail: {
              selector: selector,
              allow: part.headers["allow"]
                .split(",")
                .map((method) => method.trim()),
            },
            bubbles: true,
            composed: true,
            cancelable: true,
          });
          node.dispatchEvent(anEvent);
        });
      }
    }
  }
}

class PLElement {
  #document;
  #element;

  constructor(url, element) {
    this.url = url;

    if (element) {
      this.element = element;
    }

    Object.defineProperty(this, "selector", {
      get: generateSelector.bind(this.#element),
      enumerable: true,
      configurable: true,
    });
  }

  get element() {
    return this.#element;
  }

  set element(aVal) {
    this.#element = aVal;
    this.document = aVal.ownerDocument;
  }

  get document() {
    return this.#document;
  }

  set document(aVal) {
    this.#document = aVal;
  }

  req(method, opts) {
    const hasBody = opts && opts.body !== undefined && opts.body !== null;
    const details = {
      method,
      headers: {
        Range: `selector=${this.selector}`,
        ...(hasBody && { "Content-Type": "text/html;charset=UTF-8" }),
        ...(method !== "POST" &&
          typeof this.element.etag === "string" && {
            "If-Match": this.element.etag,
          }),
      },
      ...opts,
    };
    return new Request(this.url, details);
  }

  /**
   * Issue `request`, announcing the operation's start and completion.
   *
   * `finalize` — when given — performs the verb's own local DOM work and runs
   * BEFORE completion is announced. That ordering is load-bearing: the SSE
   * client keeps this write's echo suppressed only until PLMethodCompleted
   * fires, so any DOM change made after that event could be applied twice if
   * the server echoes the write back to the connection that made it. Its
   * return value, when it returns one, becomes this method's result.
   */
  async #processRequest(request, finalize) {
    const range = request.headers.get("Range");
    const selector = range ? range.replace("selector=", "") : "";
    this.element.dispatchEvent(
      new CustomEvent("PLMethodStarted", {
        detail: { method: request.method, selector },
        bubbles: true,
        composed: true,
      }),
    );
    const response = await fetch(request);
    const etag = response.headers.get("etag");
    if (etag) this.element.etag = etag;

    let result = response;
    try {
      if (finalize) {
        const finalized = await finalize(response);
        if (finalized !== undefined) result = finalized;
      }
    } finally {
      // Announced in a finally so that a finalize that throws — an unreadable
      // or malformed response body, say — still ends the operation. Otherwise
      // the entry PLMethodStarted added to the SSE echo-suppression queue is
      // orphaned, and goes on discarding matching mutations until it ages out.
      // The error itself still propagates to the caller.
      this.element.dispatchEvent(
        new CustomEvent("PLMethodCompleted", {
          detail: {
            method: request.method,
            selector,
            response,
          },
          bubbles: true,
          composed: true,
          cancelable: true,
        }),
      );
    }
    return result;
  }

  async DELETE() {
    // The removal below needs no `finalize` hook: there is no await between
    // this call resolving and `.remove()`, so no event can be delivered in
    // between and the DOM change cannot race the completion announcement.
    // Introducing an await here would reopen that window — see #processRequest.
    const response = await this.#processRequest(this.req("DELETE"));
    if (response.ok) this.element.remove();
    else {
      Debug.warn(
        Debug.PRIMITIVES,
        `[PLPrimitives] DELETE request failed with status ${response.status}`,
      );
    }
    return response;
  }

  async POST(body) {
    if (!body) throw new Error(`POST requires a body paramter`);
    const originalNode = body instanceof Node ? body : null;
    const alreadyAttached = originalNode && originalNode.parentNode;
    if (body instanceof Node) body = serializeForRequest(body);
    // The append happens inside finalize so that it is done before
    // PLMethodCompleted is announced — see #processRequest.
    return await this.#processRequest(this.req("POST", { body }), async (response) => {
      if (!response.ok) return response;
      const responseText = await response.text();
      const newChild = htmlToNode(responseText);
      if (!alreadyAttached) this.#element.appendChild(newChild);
      // RFC 9110 §8.8.3 / RFC 8594: ETag describes the selected
      // representation of the resource identified by the request
      // URI unless `Content-Location` names a different resource,
      // in which case ETag applies to *that* resource.
      //
      // For POST-appends-child:
      //   no Content-Location, or same as URI → ETag is the parent's.
      //   Content-Location ≠ URI                → ETag is the new child's.
      //
      // We never assume the parent's ETag applies to the child
      // (doing so produced stale If-Match on the first write
      // against the child, causing 412).
      const etag = response.headers.get("etag");
      const contentLocation = response.headers.get("content-location");
      const requestUri = new URL(this.url, window.location.href).pathname;
      const locationUri = contentLocation
        ? new URL(contentLocation, window.location.href)
        : null;
      const etagIsForChild =
        locationUri &&
        (locationUri.pathname !== requestUri ||
          locationUri.search !== "" ||
          locationUri.hash !== "");
      if (etag) {
        if (etagIsForChild) {
          const target = alreadyAttached ? originalNode : newChild;
          if (target) target.etag = etag;
          // Parent's ETag changed server-side but wasn't sent
          // back; clear it so the next write refetches via HEAD
          // rather than using a stale If-Match.
          this.#element.etag = undefined;
        } else {
          // ETag is for the parent. Child's ETag is unknown —
          // leave it undefined so subsequent writes on the
          // child skip If-Match (or trigger a lazy HEAD).
          this.#element.etag = etag;
        }
      } else {
        // Server sent no ETag. Parent's current etag is stale;
        // drop it to avoid mismatched If-Match on next write.
        this.#element.etag = undefined;
      }
      return new Response(responseText, response);
    });
  }

  async PUT(body) {
    if (!body) body = serializeForRequest(this.element);
    else if (body instanceof Node) body = serializeForRequest(body);
    return await this.#processRequest(this.req("PUT", { body }));
  }

  async GET() {
    const response = await this.#processRequest(this.req("GET"));
    if (response.ok) {
      const responseText = await response.text();
      const newElement = htmlToNode(responseText);
      return newElement;
    } else {
      throw new Response(responseText, response);
    }
  }
}

class PLDocument {
  #document;
  #etagObserver;

  constructor(url) {
    if (!url) url = window.location.href.split("#")[0];
    this.url = url;

    if (this.url === window.location.href.split("#")[0]) {
      this.document = window.document;
    }

    return this;
  }

  set document(aVal) {
    this.#document = aVal;
    this.#document.pagelove = new WeakRef(this);

    this.#document.addEventListener("PLCapability", async (event) => {
      for (const method of event.detail.allow) {
        const element = await this.createElement(event.target);
        const methodName = method.toUpperCase();
        if (typeof element[methodName] !== "function") continue;
        Object.defineProperty(event.target, methodName, {
          value: element[methodName].bind(element),
          writable: false,
          enumerable: true,
          configurable: true,
        });
      }
      // Lazily fetch ETags only when elements become visible (IntersectionObserver)
      // Only for top-level mutable elements with IDs. Skip view elements
      // (data-for): their id is a client-side binding to a source
      // element elsewhere and isn't addressable on the server.
      if (
        event.target.id &&
        event.target.etag === undefined &&
        !event.target.hasAttribute("data-for")
      ) {
        this.#observeForETag(event.target);
      }
    });

    this.#document.addEventListener("PLMethodCompleted", async (event) => {
      const response = event.detail.response;
      if (!response.ok) {
        Debug.error(
          Debug.PRIMITIVES,
          `[PLPrimitives] PLMethod ${event.detail.method} failed with status ${event.detail.response.status}`,
        );
      }
    });
  }

  #observeForETag(element) {
    if (!this.#etagObserver) {
      this.#etagObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target;
            this.#etagObserver.unobserve(el);
            el.etag = null;
            const selector = generateSelector.call(el);
            fetch(this.url, {
              method: "HEAD",
              headers: { Range: `selector=${selector}` },
            })
              .then((response) => {
                const etag = response.headers.get("etag");
                el.etag = etag || undefined;
              })
              .catch(() => {
                el.etag = undefined;
              });
          }
        },
        { rootMargin: "200px" },
      );
    }
    this.#etagObserver.observe(element);
  }

  get document() {
    if (!this.#document) {
      return (async () => {
        const response = await fetch(this.url);
        const text = await response.text();
        const parser = new DOMParser();
        this.#document = parser.parseFromString(text, "text/html");
        return this.#document;
      })();
    }

    return (async () => {
      return this.#document;
    })();
  }

  async createElement(element) {
    return new PLElement(this.url, element);
  }

  req(method, ...opts) {
    return new Request(this.url, {
      method,
      headers: {},
      ...opts,
    });
  }

  async OPTIONS() {
    return OPTIONS(this);
  }
}

export { PLDocument, PLElement };
