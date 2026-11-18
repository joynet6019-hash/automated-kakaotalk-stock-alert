(() => {
  "use strict";

  const content = document.querySelector("#docContent");
  const loading = document.querySelector("#loadingState");
  const errorState = document.querySelector("#errorState");
  const emptyState = document.querySelector("#emptyState");
  const search = document.querySelector("#docSearch");
  const searchResult = document.querySelector("#searchResult");
  const toc = document.querySelector("#toc");
  const toolbar = document.querySelector("#docToolbar");
  const sidebar = document.querySelector("#sidebar");
  const backdrop = document.querySelector("#sidebarBackdrop");
  const menuButton = document.querySelector("#menuButton");
  const closeMenu = document.querySelector("#closeMenu");
  const backToTop = document.querySelector("#backToTop");
  const progress = document.querySelector("#readingProgress");

  const escapeHtml = (value) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  function inline(text) {
    let safe = escapeHtml(text);
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
    safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return safe;
  }

  function renderTable(lines) {
    const rows = lines.map((line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    const headings = rows[0];
    const body = rows.slice(2);
    return `<table><thead><tr>${headings.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>` +
      `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  }

  function markdownToHtml(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let paragraph = [];
    let listType = null;
    let listItems = [];
    let inCode = false;
    let codeLang = "text";
    let codeLines = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    };

    const flushList = () => {
      if (!listItems.length) return;
      const taskClass = listItems.some((item) => item.task) ? ' class="task-list"' : "";
      out.push(`<${listType}${taskClass}>` + listItems.map((item) => {
        const box = item.task ? `<span class="task-box${item.checked ? " checked" : ""}" aria-hidden="true"></span>` : "";
        return `<li>${box}${inline(item.text)}</li>`;
      }).join("") + `</${listType}>`);
      listType = null;
      listItems = [];
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      if (inCode) {
        if (line.startsWith("```")) {
          out.push(`<div class="code-wrap" data-language="${escapeHtml(codeLang)}"><pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`);
          inCode = false;
          codeLines = [];
        } else {
          codeLines.push(line);
        }
        continue;
      }

      if (line.startsWith("```")) {
        flushParagraph();
        flushList();
        inCode = true;
        codeLang = line.slice(3).trim() || "text";
        continue;
      }

      if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-+/.test(lines[i + 1])) {
        flushParagraph();
        flushList();
        const tableLines = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
          tableLines.push(lines[i]);
          i += 1;
        }
        i -= 1;
        out.push(renderTable(tableLines));
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        continue;
      }

      const unordered = line.match(/^\s*-\s+(.+)$/);
      const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const nextType = ordered ? "ol" : "ul";
        if (listType && listType !== nextType) flushList();
        listType = nextType;
        let itemText = (unordered || ordered)[1];
        const task = itemText.match(/^\[([ xX])\]\s+(.+)$/);
        listItems.push({
          text: task ? task[2] : itemText,
          task: Boolean(task),
          checked: task ? task[1].toLowerCase() === "x" : false,
        });
        continue;
      }

      if (line.startsWith("> ")) {
        flushParagraph();
        flushList();
        out.push(`<blockquote><p>${inline(line.slice(2))}</p></blockquote>`);
        continue;
      }

      if (/^---+$/.test(line.trim())) {
        flushParagraph();
        flushList();
        out.push("<hr>");
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      if (listItems.length && /^\s{2,}\S/.test(line)) {
        listItems[listItems.length - 1].text += ` ${line.trim()}`;
        continue;
      }
      paragraph.push(line.trim());
    }

    flushParagraph();
    flushList();
    if (inCode) out.push(`<div class="code-wrap" data-language="${escapeHtml(codeLang)}"><pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre></div>`);
    return out.join("\n");
  }

  function groupIntoSections() {
    const title = content.querySelector("h1");
    if (title) title.remove();
    const introNodes = [];
    while (content.firstElementChild && content.firstElementChild.tagName !== "H2") {
      introNodes.push(content.firstElementChild);
      content.firstElementChild.remove();
    }
    if (introNodes.length) {
      const intro = document.createElement("div");
      intro.className = "doc-intro sr-only";
      introNodes.forEach((node) => intro.append(node));
      content.prepend(intro);
    }

    const nodes = [...content.children];
    let section = null;
    let sectionNumber = 0;
    nodes.forEach((node) => {
      if (node.tagName === "H2") {
        sectionNumber += 1;
        section = document.createElement("section");
        section.className = "doc-section";
        section.id = `section-${sectionNumber}`;
        if (sectionNumber === 17) section.classList.add("is-incident");
        if (sectionNumber === 18) section.classList.add("is-solution");
        content.insertBefore(section, node);
        const text = node.textContent.replace(/^\d+\.\s*/, "");
        node.innerHTML = `<span class="section-no">${String(sectionNumber).padStart(2, "0")}</span><span>${escapeHtml(text)}</span>`;
        section.append(node);
      } else if (section) {
        section.append(node);
      }
    });
  }

  function buildToc() {
    const sections = [...content.querySelectorAll(".doc-section")];
    toc.innerHTML = sections.map((section, index) => {
      const label = section.querySelector("h2 span:last-child").textContent;
      return `<a href="#${section.id}" data-number="${String(index + 1).padStart(2, "0")}">${escapeHtml(label)}</a>`;
    }).join("");

    toc.addEventListener("click", (event) => {
      if (event.target.closest("a")) setSidebar(false);
    });

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        toc.querySelectorAll("a").forEach((link) => link.classList.toggle("active", link.hash === `#${entry.target.id}`));
      });
    }, { rootMargin: "-18% 0px -72%", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
  }

  function addCodeButtons() {
    content.querySelectorAll(".code-wrap").forEach((wrap) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code";
      button.textContent = "복사";
      button.addEventListener("click", async () => {
        const code = wrap.querySelector("code").textContent;
        try {
          await navigator.clipboard.writeText(code);
          button.textContent = "복사됨";
          setTimeout(() => { button.textContent = "복사"; }, 1400);
        } catch {
          button.textContent = "실패";
        }
      });
      wrap.append(button);
    });
  }

  function filterSections(query) {
    const normalized = query.trim().toLocaleLowerCase("ko");
    const sections = [...content.querySelectorAll(".doc-section")];
    let count = 0;
    sections.forEach((section) => {
      const matches = !normalized || section.textContent.toLocaleLowerCase("ko").includes(normalized);
      section.hidden = !matches;
      if (matches) count += 1;
    });
    emptyState.hidden = count !== 0;
    searchResult.textContent = normalized ? `${count}개 장 검색됨` : `전체 ${sections.length}개 장`;
  }

  function setSidebar(open) {
    sidebar.classList.toggle("open", open);
    backdrop.classList.toggle("open", open);
    menuButton.setAttribute("aria-expanded", String(open));
    document.body.style.overflow = open ? "hidden" : "";
  }

  async function loadManual() {
    try {
      const response = await fetch("./manual.md", { cache: "no-store" });
      if (!response.ok) throw new Error(`manual_http_${response.status}`);
      const markdown = await response.text();
      content.innerHTML = markdownToHtml(markdown);
      groupIntoSections();
      buildToc();
      addCodeButtons();
      loading.hidden = true;
      content.hidden = false;
      if (location.hash && document.querySelector(location.hash)) {
        requestAnimationFrame(() => document.querySelector(location.hash).scrollIntoView());
      }
    } catch (error) {
      console.error("manual_load_failed", error);
      loading.hidden = true;
      errorState.hidden = false;
      toc.innerHTML = '<div class="toc-loading">문서를 불러오지 못했습니다.</div>';
    }
  }

  search.addEventListener("input", () => filterSections(search.value));
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      search.value = "";
      filterSections("");
      search.blur();
    }
  });
  document.querySelector("#clearSearch").addEventListener("click", () => {
    search.value = "";
    filterSections("");
    search.focus();
  });
  document.querySelector("#openSearch").addEventListener("click", () => {
    toolbar.scrollIntoView({ block: "center" });
    setTimeout(() => search.focus(), 250);
  });
  document.querySelector("#printButton").addEventListener("click", () => window.print());
  menuButton.addEventListener("click", () => setSidebar(true));
  closeMenu.addEventListener("click", () => setSidebar(false));
  backdrop.addEventListener("click", () => setSidebar(false));
  backToTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
      event.preventDefault();
      search.focus();
    }
    if (event.key === "Escape") setSidebar(false);
  });

  window.addEventListener("scroll", () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.width = `${max > 0 ? (scrollY / max) * 100 : 0}%`;
    backToTop.classList.toggle("visible", scrollY > 700);
  }, { passive: true });

  loadManual();
})();
