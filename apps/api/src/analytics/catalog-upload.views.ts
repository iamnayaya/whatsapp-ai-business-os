import { brand, brandCssVars, faviconDataUri } from '../../../../packages/shared/src';
import type { GeneratedListing } from '../../../../packages/ai/src';
import type { Category } from './catalog-upload.service';

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${brand.fonts.googleStylesheet}">`;
const FAVICON = `<link rel="icon" type="image/svg+xml" href="${faviconDataUri()}">`;
const LOGO_IMG = '<img src="/assets/nayaya-logo.png" alt="NAYAYA & CO." class="brand-logo">';

const CSS = `
  :root {
    ${brandCssVars()}
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family: var(--brand-sans); background: var(--brand-base); color: var(--brand-ink); }
  header { background: var(--brand-surface); border-bottom: 1px solid var(--brand-line); padding: 12px 22px; display:flex; align-items:center; justify-content: space-between; gap: 12px; }
  header .brand { display:flex; align-items:center; gap: 12px; }
  header .brand .brand-logo { height: 40px; width: auto; display: block; }
  header .brand-title { font-family: var(--brand-serif); font-size: 18px; color: var(--brand-primary); margin: 0; letter-spacing: .02em; }
  header .meta { color: var(--brand-muted); font-size: 13px; }
  main { max-width: 720px; margin: 20px auto 60px; padding: 0 16px; }
  section { background: var(--brand-surface); border:1px solid var(--brand-line); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  section h2 { margin: 0 0 12px; font-size: 15px; font-family: var(--brand-serif); color: var(--brand-secondary); }
  .form-group { margin-bottom: 16px; }
  label { display:block; font-size: 13px; font-weight: 600; color: var(--brand-ink); margin-bottom: 6px; }
  label .required { color: var(--brand-frustrated); margin-left: 2px; }
  input[type="text"], input[type="number"], select { width: 100%; padding: 10px 12px; border:1px solid var(--brand-line); border-radius: 8px; font-size: 14px; background: var(--brand-base); color: var(--brand-ink); font-family: var(--brand-sans); }
  input[type="text"]:focus, input[type="number"]:focus, select:focus { outline: none; border-color: var(--brand-primary); box-shadow: 0 0 0 3px var(--brand-primary-bg); }
  .file-drop-zone { border: 2px dashed var(--brand-line); border-radius: 12px; padding: 32px 16px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; background: var(--brand-base); }
  .file-drop-zone:hover, .file-drop-zone.drag-over { border-color: var(--brand-primary); background: var(--brand-primary-bg); }
  .file-drop-zone input[type="file"] { display: none; }
  .file-drop-zone .icon { font-size: 48px; margin-bottom: 12px; }
  .file-drop-zone .text { color: var(--brand-muted); font-size: 14px; }
  .file-drop-zone .hint { color: var(--brand-muted); font-size: 12px; margin-top: 8px; }
  .file-previews { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
  .file-preview { position: relative; width: 100px; height: 100px; border-radius: 8px; overflow: hidden; border: 1px solid var(--brand-line); background: var(--brand-base); }
  .file-preview img { width: 100%; height: 100%; object-fit: cover; }
  .file-preview .remove { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 50%; background: var(--brand-frustrated-bg); color: var(--brand-frustrated); border: none; cursor: pointer; font-size: 16px; line-height: 24px; text-align: center; }
  .file-preview .remove:hover { background: var(--brand-frustrated); color: var(--brand-on-frustrated); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 20px; border: 0; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: var(--brand-sans); transition: background 0.2s; }
  .btn-primary { background: var(--brand-primary); color: var(--brand-on-primary); }
  .btn-primary:hover { background: var(--brand-primary-hover); }
  .btn-secondary { background: var(--brand-surface); color: var(--brand-ink); border: 1px solid var(--brand-line); }
  .btn-secondary:hover { background: var(--brand-base); }
  .btn-danger { background: var(--brand-frustrated-bg); color: var(--brand-frustrated); }
  .btn-danger:hover { background: var(--brand-frustrated); color: var(--brand-on-frustrated); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-group { display: flex; gap: 12px; flex-wrap: wrap; }
  .error { color: var(--brand-frustrated); font-size: 13px; margin-top: 8px; }
  .success { color: var(--brand-positive); font-size: 13px; margin-top: 8px; }
  .muted { color: var(--brand-muted); font-size: 13px; }
  .listing-preview { background: var(--brand-base); border: 1px solid var(--brand-line); border-radius: 8px; padding: 16px; margin-top: 16px; }
  .listing-preview h3 { margin: 0 0 12px; font-size: 14px; font-family: var(--brand-serif); color: var(--brand-secondary); }
  .listing-preview .field { margin-bottom: 12px; }
  .listing-preview .field-label { font-size: 12px; color: var(--brand-muted); text-transform: uppercase; letter-spacing: .04em; margin-bottom: 4px; }
  .listing-preview .field-value { font-size: 14px; color: var(--brand-ink); }
  .listing-preview textarea { width: 100%; min-height: 100px; padding: 10px 12px; border:1px solid var(--brand-line); border-radius: 8px; font-size: 14px; background: var(--brand-surface); color: var(--brand-ink); font-family: var(--brand-sans); resize: vertical; }
  .listing-preview .tags-input { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .tag-chip { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; border-radius: 999px; background: var(--brand-primary-bg); color: var(--brand-primary); font-size: 12px; font-weight: 600; }
  .tag-chip input { border: none; background: transparent; color: inherit; font: inherit; padding: 0; width: 60px; }
  .tag-chip button { background: none; border: none; color: inherit; cursor: pointer; padding: 0; line-height: 1; }
  .tag-input { padding: 4px 10px; border: 1px solid var(--brand-line); border-radius: 999px; background: var(--brand-base); color: var(--brand-ink); font-size: 12px; width: 120px; }
  .review-reason { background: var(--brand-frustrated-bg); border: 1px solid var(--brand-frustrated); color: var(--brand-frustrated); padding: 12px; border-radius: 8px; margin-bottom: 16px; }
  .progress-bar { width: 100%; height: 8px; background: var(--brand-base); border-radius: 4px; overflow: hidden; margin-bottom: 16px; }
  .progress-bar .fill { height: 100%; background: var(--brand-primary); transition: width 0.3s; }
  .step-indicator { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .step { flex: 1; text-align: center; position: relative; }
  .step:not(:last-child)::after { content: ''; position: absolute; top: 12px; left: 50%; width: 100%; height: 2px; background: var(--brand-line); z-index: 0; }
  .step.active .step-number { background: var(--brand-primary); color: var(--brand-on-primary); }
  .step.completed .step-number { background: var(--brand-positive); color: var(--brand-on-positive); }
  .step-number { width: 24px; height: 24px; border-radius: 50%; background: var(--brand-line); color: var(--brand-muted); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; z-index: 1; }
  .step-label { display: block; margin-top: 8px; font-size: 11px; color: var(--brand-muted); }
  .step.active .step-label { color: var(--brand-primary); font-weight: 600; }
  .step.completed .step-label { color: var(--brand-positive); }
  .success-card { text-align: center; padding: 32px 16px; }
  .success-icon { font-size: 64px; margin-bottom: 16px; }
  .success-title { font-family: var(--brand-serif); font-size: 24px; color: var(--brand-secondary); margin: 0 0 8px; }
  .success-message { color: var(--brand-muted); margin-bottom: 24px; }
  .product-summary { background: var(--brand-base); border: 1px solid var(--brand-line); border-radius: 8px; padding: 16px; text-align: left; margin-bottom: 24px; }
  .product-summary .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--brand-line); }
  .product-summary .row:last-child { border-bottom: none; }
  .product-summary .label { color: var(--brand-muted); }
  .product-summary .value { font-weight: 600; }
  @media (max-width: 760px) {
    header { padding: 12px 16px; }
    main { padding: 0 12px; }
    .btn-group { flex-direction: column; }
    .btn-group .btn { width: 100%; }
  }
`;

function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMoney(n: number, currency = 'NGN'): string {
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

export function renderUploadForm(
  categories: Category[],
  error?: string,
  preservedData?: { price?: string; quantity?: string; category?: string; sku?: string },
  nonce?: string,
): string {
  const categoryOptions = categories.map(c => `<option value="${escapeHtml(c)}"${preservedData?.category === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');
  const scriptNonce = nonce ? ` nonce="${escapeHtml(nonce)}"` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON}
${FONTS}
<title>Catalog Upload — Add Products</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand">${LOGO_IMG}<span class="brand-title">Catalog Upload</span></div>
  <div class="meta"><a href="/admin" style="color: var(--brand-muted); text-decoration: none;">← Dashboard</a></div>
</header>
<main>
  <section>
    <h2>Add New Products</h2>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
    <form id="uploadForm" method="post" action="/admin/catalog/new" enctype="multipart/form-data">
      <div class="form-group">
        <label>Images <span class="required">*</span></label>
        <div class="file-drop-zone" id="dropZone">
          <div class="icon">📷</div>
          <div class="text">Drag & drop photos here, or tap to select</div>
          <div class="hint">Multiple images allowed — each will be reviewed separately</div>
          <input type="file" id="images" name="images" accept="image/*" multiple required>
        </div>
        <div class="file-previews" id="previews"></div>
      </div>

      <div class="form-group">
        <label>Price <span class="required">*</span></label>
        <input type="number" name="price" id="price" min="0" step="1" placeholder="e.g. 85000" value="${escapeHtml(preservedData?.price ?? '')}" required>
      </div>

      <div class="form-group">
        <label>Quantity <span class="required">*</span></label>
        <input type="number" name="quantity" id="quantity" min="0" step="1" placeholder="e.g. 40" value="${escapeHtml(preservedData?.quantity ?? '')}" required>
      </div>

      <div class="form-group">
        <label>Category</label>
        <select name="category" id="category">
          <option value="">Select category (optional)</option>
          ${categoryOptions}
        </select>
      </div>

      <div class="form-group">
        <label>SKU (optional)</label>
        <input type="text" name="sku" id="sku" placeholder="Auto-generated if left blank" value="${escapeHtml(preservedData?.sku ?? '')}">
      </div>

      <div class="btn-group">
        <button type="submit" class="btn btn-primary">Upload & Review</button>
        <a href="/admin" class="btn btn-secondary">Cancel</a>
      </div>
    </form>
  </section>
</main>
<script${scriptNonce}>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('images');
const previews = document.getElementById('previews');

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); }, false);
});

['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.add('drag-over'), false);
});

['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.remove('drag-over'), false);
});

dropZone.addEventListener('drop', e => {
  const files = e.dataTransfer.files;
  if (files.length) { fileInput.files = files; updatePreviews(files); }
}, false);

fileInput.addEventListener('change', e => {
  updatePreviews(e.target.files);
});

function updatePreviews(files) {
  previews.innerHTML = '';
  Array.from(files).forEach((file, idx) => {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const div = document.createElement('div');
      div.className = 'file-preview';
      div.innerHTML = '<img src="' + ev.target.result + '" alt="">' +
        '<button type="button" class="remove" data-idx="' + idx + '" aria-label="Remove">&times;</button>';
      previews.appendChild(div);
    };
    reader.readAsDataURL(file);
  });
}

previews.addEventListener('click', e => {
  const btn = e.target.closest('.remove');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  const dt = new DataTransfer();
  Array.from(fileInput.files).forEach((file, i) => { if (i !== idx) dt.items.add(file); });
  fileInput.files = dt.files;
  updatePreviews(fileInput.files);
});

dropZone.addEventListener('click', e => {
  if (e.target === dropZone || e.target.closest('.icon') || e.target.closest('.text') || e.target.closest('.hint')) {
    fileInput.click();
  }
});
</script>
</body>
</html>`;
}

const DEFAULT_CATEGORIES: Category[] = [
  'Furniture',
  'Carpets',
  'Electronics',
  'Artificial Flowers',
  'Decor & Frames',
];

export function renderReviewPage(
  reviewId: string,
  listing: GeneratedListing,
  filename: string,
  step: number,
  totalSteps: number,
  error?: string,
  editData?: { title?: string; description?: string; tags?: string[]; category?: string },
  categories: Category[] = DEFAULT_CATEGORIES,
): string {
  const tags = (editData?.tags ?? listing.tags).join(', ');
  const categoryOptions = categories.map(c => `<option value="${escapeHtml(c)}"${(editData?.category ?? listing.category) === c ? ' selected' : ''}>${escapeHtml(c)}</option>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON}
${FONTS}
<title>Review Listing — ${escapeHtml(filename)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand">${LOGO_IMG}<span class="brand-title">Review Listing</span></div>
  <div class="meta">${escapeHtml(filename)}</div>
</header>
<main>
  <div class="step-indicator">
    <div class="step ${step >= 1 ? 'completed' : ''}"><div class="step-number">1</div><span class="step-label">Upload</span></div>
    <div class="step ${step >= 2 ? 'active' : ''}"><div class="step-number">2</div><span class="step-label">Review</span></div>
    <div class="step"><div class="step-number">3</div><span class="step-label">Publish</span></div>
  </div>

  <div class="progress-bar"><div class="fill" style="width: ${Math.round((step / 3) * 100)}%"></div></div>

  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}

  <section>
    <h2>Proposed Listing for ${escapeHtml(filename)}</h2>
    <form id="reviewForm" method="post" action="/admin/catalog/review/${reviewId}">
      <div class="listing-preview">
        <div class="form-group">
          <label>Title <span class="required">*</span></label>
          <input type="text" name="title" value="${escapeHtml(editData?.title ?? listing.title)}" required>
        </div>
        <div class="form-group">
          <label>Description <span class="required">*</span></label>
          <textarea name="description" required>${escapeHtml(editData?.description ?? listing.description)}</textarea>
        </div>
        <div class="form-group">
          <label>Tags (comma-separated)</label>
          <input type="text" name="tags" value="${escapeHtml(tags)}" placeholder="e.g. furniture, living-room, sofa">
        </div>
        <div class="form-group">
          <label>Category</label>
          <select name="category">
            <option value="">Auto-detect</option>
            ${categoryOptions}
          </select>
        </div>
      </div>

      <div class="btn-group">
        <button type="submit" name="action" value="approve" class="btn btn-primary">Approve & Publish</button>
        <button type="submit" name="action" value="edit" class="btn btn-secondary">Edit & Approve</button>
        <button type="submit" name="action" value="reject" class="btn btn-danger">Reject</button>
      </div>
    </form>
  </section>
</main>
</body>
</html>`;
}

export function renderImageRejectedPage(
  filename: string,
  reason: string,
  preservedData: { price?: string; quantity?: string; category?: string; sku?: string },
  categories: Category[],
  nonce?: string,
): string {
  const cleanReason = reason.replace(/\.\s*$/, '');
  return renderUploadForm(categories, `Image rejected: ${escapeHtml(cleanReason)}. Please upload a clearer photo.`, preservedData, nonce);
}

export function renderSuccessPage(
  product: { title: string; sku: string; price: number; quantity: number; category?: string },
  currency = 'NGN'
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON}
${FONTS}
<title>Product Published — Success</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="brand">${LOGO_IMG}<span class="brand-title">Catalog Upload</span></div>
  <div class="meta"><a href="/admin" style="color: var(--brand-muted); text-decoration: none;">← Dashboard</a></div>
</header>
<main>
  <section class="success-card">
    <div class="success-icon">✅</div>
    <h1 class="success-title">Product Published!</h1>
    <p class="success-message">Your product has been added to the catalog and is now searchable.</p>

    <div class="product-summary">
      <div class="row"><span class="label">Title</span><span class="value">${escapeHtml(product.title)}</span></div>
      <div class="row"><span class="label">SKU</span><span class="value">${escapeHtml(product.sku)}</span></div>
      <div class="row"><span class="label">Price</span><span class="value">${formatMoney(product.price, currency)}</span></div>
      <div class="row"><span class="label">Quantity</span><span class="value">${product.quantity}</span></div>
      ${product.category ? `<div class="row"><span class="label">Category</span><span class="value">${escapeHtml(product.category)}</span></div>` : ''}
    </div>

    <a href="/admin/catalog/new" class="btn btn-primary">Upload Another Product</a>
    <a href="/admin" class="btn btn-secondary" style="margin-top: 12px;">Back to Dashboard</a>
  </section>
</main>
</body>
</html>`;
}