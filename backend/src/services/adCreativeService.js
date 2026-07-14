const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { toFile } = require('openai');
const openai = require('./openai');
const pool = require('./db');
const { generationCompletionOptions } = require('../config/openaiModels');
const brandAssetService = require('./brandAssetService');

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';

async function loadCampaignContext(campaignId) {
  const { rows } = await pool.query(
    `SELECT c.*, b.name AS brand_name, b.slug AS brand_slug, b.website AS brand_website,
            b.brand_voice, b.logo_url
     FROM campaigns c
     LEFT JOIN brands b ON b.id = c.brand_id
     WHERE c.id = $1`,
    [campaignId]
  );
  if (!rows[0]) throw new Error('Campaign not found');
  return rows[0];
}

async function loadBrandContext(brandId, {
  name = 'Standalone ad',
  brief = '',
  targetUrl = '',
} = {}) {
  const { rows } = await pool.query('SELECT * FROM brands WHERE id = $1', [brandId]);
  if (!rows[0]) throw new Error('Brand not found');
  const brand = rows[0];
  return {
    id: null,
    brand_id: brand.id,
    brand_name: brand.name,
    brand_slug: brand.slug,
    brand_website: brand.website,
    brand_voice: brand.brand_voice,
    logo_url: brand.logo_url,
    name,
    campaign_overview: brief,
    campaign_goal: brief,
    target_url: targetUrl || brand.website,
  };
}

function contextBlock(campaign, assets = []) {
  const assetLines = assets.length
    ? assets.map((a) => `- ${a.kind}: ${a.label || a.url}`).join('\n')
    : '- (none uploaded yet)';

  return `BRAND: ${campaign.brand_name || 'Unknown'}
BRAND VOICE: ${campaign.brand_voice || 'Clear, confident, on-brand.'}
WEBSITE: ${campaign.brand_website || campaign.target_url || ''}
CAMPAIGN: ${campaign.name}
OVERVIEW: ${campaign.campaign_overview || ''}
GOAL: ${campaign.campaign_goal || ''}
TARGET URL: ${campaign.target_url || campaign.brand_website || ''}
BRAND ASSETS ON FILE:
${assetLines}`;
}

async function loadBrandAssets(brandId) {
  if (!brandId) return [];
  try {
    return await brandAssetService.listAssets(brandId);
  } catch (err) {
    console.warn('Could not load brand assets:', err.message);
    return [];
  }
}

/**
 * AI text ad builder — Google RSA-style + Meta social copy variants.
 */
async function generateTextAdsForContext(campaign, { format = 'both', angle = '', count = 3 } = {}) {
  const assets = await loadBrandAssets(campaign.brand_id);
  const parsedContext = await brandAssetService.getParsedContext(campaign.brand_id);
  const wantSearch = format === 'search' || format === 'both';
  const wantSocial = format === 'social' || format === 'both';

  const hasVisuals = assets.some((a) => (a.mime_type || '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(a.url || ''));

  const prompt = `You are an expert paid media copywriter. Build ad creatives for this brand campaign.

${contextBlock(campaign, assets)}

PARSED DATA ROOM CONTEXT:
${parsedContext || '(No parsed documents yet.)'}

ANGLE / NOTES FROM MARKETER: ${angle || 'None — pick the strongest conversion angle from the goal.'}

OUTPUT RULES:
- Return JSON only.
- Search headlines: max 30 characters each. Provide 10–15.
- Search descriptions: max 90 characters each. Provide 3–4.
- Social primary texts: 1–3 sentences, conversational, brand-forward. Provide ${count} variants.
- Social headlines: short punchy (≤40 chars). Provide ${count}.
- Social descriptions: ≤60 chars. Provide ${count}.
- CTAs: pick from Learn More, Sign Up, Get Started, Shop Now, Apply Now, Book Now, Download, Subscribe — include 3–5 that fit.
- Include display_path suggestions (2 short URL path segments, no spaces) for search.
${hasVisuals ? '- Brand has logo/product/screenshot assets; copy may reference the product UI or brand mark where natural, without describing file names.' : ''}

Schema:
{
  "angle_used": "string",
  "search": {
    "headlines": ["..."],
    "descriptions": ["..."],
    "path1": "string",
    "path2": "string"
  },
  "social": {
    "primary_texts": ["..."],
    "headlines": ["..."],
    "descriptions": ["..."],
    "ctas": ["..."]
  },
  "recommended": {
    "primary_text": "...",
    "headline": "...",
    "description": "...",
    "cta": "..."
  }
}

${wantSearch ? 'Include search.' : 'Set search to null.'}
${wantSocial ? 'Include social.' : 'Set social to null.'}`;

  const completion = await openai.chat.completions.create(
    generationCompletionOptions({
      messages: [
        { role: 'system', content: 'You write high-converting paid ad copy. Respond with valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
    })
  );

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch {
    throw new Error('Failed to parse text ad builder response');
  }

  if (parsed.search?.headlines) {
    parsed.search.headlines = parsed.search.headlines.map((h) => String(h).slice(0, 30));
  }
  if (parsed.search?.descriptions) {
    parsed.search.descriptions = parsed.search.descriptions.map((d) => String(d).slice(0, 90));
  }

  return {
    campaign_id: campaign.id || null,
    brand_id: campaign.brand_id,
    format,
    assets_available: assets.map((a) => ({ id: a.id, kind: a.kind, label: a.label })),
    ...parsed,
  };
}

async function generateTextAds(campaignId, options = {}) {
  return generateTextAdsForContext(await loadCampaignContext(campaignId), options);
}

async function generateBrandTextAds(brandId, options = {}) {
  const context = await loadBrandContext(brandId, options);
  return generateTextAdsForContext(context, options);
}

async function buildImageFiles(refs) {
  const files = [];
  for (const ref of refs) {
    const local = brandAssetService.resolveLocalPath(ref.url);
    if (!local || !fsSync.existsSync(local)) {
      console.warn('Skipping missing brand asset file:', ref.url);
      continue;
    }
    const ext = path.extname(local).toLowerCase() || '.png';
    const mime =
      ref.mime_type ||
      (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
        ext === '.webp' ? 'image/webp' :
          ext === '.gif' ? 'image/gif' : 'image/png');
    const name = `ref_${ref.kind || 'asset'}_${ref.id}${ext}`;
    files.push(await toFile(fsSync.createReadStream(local), name, { type: mime }));
  }
  return files;
}

async function saveGeneratedImage(item, storageKey, index, meta = {}) {
  let buffer;
  if (item.b64_json) {
    buffer = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const axios = require('axios');
    const dl = await axios.get(item.url, { responseType: 'arraybuffer' });
    buffer = Buffer.from(dl.data);
  } else {
    throw new Error('Image generation returned neither url nor b64');
  }

  const uploadDir = path.join(process.cwd(), 'uploads', 'ads');
  await fs.mkdir(uploadDir, { recursive: true });
  const filename = `ad_${storageKey}_${Date.now()}_${index}.png`;
  await fs.writeFile(path.join(uploadDir, filename), buffer);

  return {
    url: `/uploads/ads/${filename}`,
    prompt: meta.prompt || null,
    revised_prompt: item.revised_prompt || null,
    format: meta.format,
    size: meta.size,
    model: IMAGE_MODEL,
    used_brand_assets: meta.used_brand_assets || false,
    reference_kinds: meta.reference_kinds || [],
  };
}

/**
 * AI visual ad builder — uses brand assets (logo/screenshots) via images.edit when available.
 */
async function generateVisualAdsForContext(campaign, {
  style = 'clean product marketing',
  format = 'square',
  count = 1,
  copyHint = '',
} = {}) {
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 3);
  const brandAssets = await loadBrandAssets(campaign.brand_id);
  const parsedContext = await brandAssetService.getParsedContext(campaign.brand_id, 12000);
  const refs = campaign.brand_id
    ? await brandAssetService.pickReferencesForAds(campaign.brand_id)
    : [];
  const imageFiles = await buildImageFiles(refs);
  const useEdit = imageFiles.length > 0;

  const size =
    format === 'landscape' ? '1536x1024' :
    format === 'portrait' ? '1024x1536' :
    '1024x1024';

  const refKinds = refs.map((r) => r.kind);
  const hasLogo = refKinds.includes('logo');
  const hasProductShot = refKinds.some((k) => ['screenshot', 'product', 'lifestyle'].includes(k));

  const promptCompletion = await openai.chat.completions.create(
    generationCompletionOptions({
      messages: [
        {
          role: 'system',
          content: useEdit
            ? 'You write precise image-edit prompts for paid social ads that incorporate provided brand reference images. Respond with JSON only.'
            : 'You write precise image prompts for paid social ads. Respond with JSON only.',
        },
        {
          role: 'user',
          content: `Create ${n} distinct ${useEdit ? 'image-edit' : 'image generation'} prompts for paid ads.

${contextBlock(campaign, brandAssets)}

PARSED DATA ROOM CONTEXT:
${parsedContext || '(No parsed documents yet.)'}

STYLE DIRECTION: ${style}
ASPECT: ${format} (${size})
COPY / OFFER HINT: ${copyHint || campaign.campaign_goal || ''}
${useEdit ? `
REFERENCE IMAGES PROVIDED (in order): ${refs.map((r, i) => `${i + 1}) ${r.kind} — ${r.label || r.url}`).join('; ')}

Edit rules:
- Treat reference images as ground truth for brand look${hasLogo ? ' — preserve the logo mark accurately; place it tastefully (corner or integrated hero), never stretch or distort.' : ''}${hasProductShot ? ' — incorporate product/UI screenshots naturally as a device mock, product panel, or background element when it strengthens the ad.' : ''}
- Compose a finished paid-social ad still, not a collage of the raw uploads.
- Do not invent competing brand logos. No watermarks, no UI chrome from other apps, no tiny unreadable text.
- Each prompt must tell the model how to use the references and be under 900 characters.` : `
Rules:
- Photorealistic or polished marketing still; no watermarks, no UI chrome, no tiny unreadable text.
- Brand name may appear once as large clean typography if it fits.
- No celebrity likenesses. No logos of other brands.
- Each prompt must be self-contained and under 900 characters.`}

JSON: { "prompts": ["...", "..."] }`,
        },
      ],
      response_format: { type: 'json_object' },
    })
  );

  let prompts = [];
  try {
    const parsed = JSON.parse(promptCompletion.choices[0]?.message?.content || '{}');
    prompts = Array.isArray(parsed.prompts) ? parsed.prompts.slice(0, n) : [];
  } catch {
    prompts = [];
  }
  if (!prompts.length) {
    if (useEdit) {
      prompts = [
        `Create a polished paid social ad for ${campaign.brand_name}. ${hasLogo ? 'Incorporate the provided logo accurately and tastefully. ' : ''}${hasProductShot ? 'Use the product/screenshot reference as a natural visual element (device mock or UI panel). ' : ''}Style: ${style}. Goal: ${campaign.campaign_goal || campaign.name}. Clean composition, premium lighting, no watermarks.`,
      ];
    } else {
      prompts = [
        `Professional advertising visual for ${campaign.brand_name}: ${campaign.campaign_goal || campaign.name}. Style: ${style}. Clean composition, premium lighting, no watermarks.`,
      ];
    }
  }

  const assets = [];
  for (let i = 0; i < prompts.length; i++) {
    const imagePrompt = prompts[i];
    let img;
    if (useEdit) {
      // Rebuild streams each call — prior readstreams are consumed
      const files = await buildImageFiles(refs);
      const editParams = {
        model: IMAGE_MODEL,
        image: files.length === 1 ? files[0] : files,
        prompt: imagePrompt,
        size,
        quality: 'medium',
      };
      try {
        img = await openai.images.edit(editParams);
      } catch (err) {
        console.warn('images.edit failed, falling back to generate:', err.message);
        img = await openai.images.generate({
          model: IMAGE_MODEL,
          prompt: `${imagePrompt}\n\n(Note: brand reference images could not be attached; keep look on-brand for ${campaign.brand_name}.)`,
          n: 1,
          size,
          quality: 'medium',
        });
      }
    } else {
      img = await openai.images.generate({
        model: IMAGE_MODEL,
        prompt: imagePrompt,
        n: 1,
        size,
        quality: 'medium',
      });
    }

    const item = img.data?.[0];
    if (!item) throw new Error('Image generation returned no data');

    assets.push(await saveGeneratedImage(item, campaign.id || `brand_${campaign.brand_id}`, i, {
      prompt: imagePrompt,
      format,
      size,
      used_brand_assets: useEdit,
      reference_kinds: refKinds,
    }));
  }

  return {
    campaign_id: campaign.id || null,
    brand_id: campaign.brand_id,
    used_brand_assets: useEdit,
    reference_assets: refs.map((r) => ({ id: r.id, kind: r.kind, label: r.label, url: r.url })),
    assets,
  };
}

async function generateVisualAds(campaignId, options = {}) {
  return generateVisualAdsForContext(await loadCampaignContext(campaignId), options);
}

async function generateBrandVisualAds(brandId, options = {}) {
  const context = await loadBrandContext(brandId, options);
  return generateVisualAdsForContext(context, options);
}

/**
 * Combined builder: text + optional visual in one pass for create-ad flow.
 */
async function buildAdCreative(campaignId, opts = {}) {
  const text = await generateTextAds(campaignId, {
    format: opts.format || 'both',
    angle: opts.angle,
    count: opts.count,
  });

  let visual = null;
  if (opts.include_visual !== false) {
    try {
      visual = await generateVisualAds(campaignId, {
        style: opts.style,
        format: opts.visual_format || 'square',
        count: opts.visual_count || 1,
        copyHint: text.recommended?.primary_text || text.social?.primary_texts?.[0],
      });
    } catch (err) {
      console.warn('Visual ad generation failed:', err.message);
      visual = { error: err.message, assets: [] };
    }
  }

  const creative = {
    message: text.recommended?.primary_text || text.social?.primary_texts?.[0] || '',
    headline: text.recommended?.headline || text.social?.headlines?.[0] || text.search?.headlines?.[0] || '',
    description: text.recommended?.description || text.social?.descriptions?.[0] || text.search?.descriptions?.[0] || '',
    cta: text.recommended?.cta || text.social?.ctas?.[0] || 'Learn More',
    search: text.search,
    social: text.social,
    angle_used: text.angle_used,
    image_url: visual?.assets?.[0]?.url || null,
    images: visual?.assets || [],
  };

  return { text, visual, creative };
}

async function buildBrandAdCreative(brandId, opts = {}) {
  const text = await generateBrandTextAds(brandId, {
    ...opts,
    format: opts.format || 'both',
    angle: opts.angle || opts.brief,
    count: opts.count || 3,
  });

  let visual = null;
  if (opts.include_visual !== false) {
    visual = await generateBrandVisualAds(brandId, {
      ...opts,
      format: opts.visual_format || 'square',
      count: opts.visual_count || 1,
      copyHint: text.recommended?.primary_text || text.social?.primary_texts?.[0],
    });
  }

  const creative = {
    message: text.recommended?.primary_text || text.social?.primary_texts?.[0] || '',
    headline: text.recommended?.headline || text.social?.headlines?.[0] || text.search?.headlines?.[0] || '',
    description: text.recommended?.description || text.social?.descriptions?.[0] || text.search?.descriptions?.[0] || '',
    cta: text.recommended?.cta || text.social?.ctas?.[0] || 'Learn More',
    search: text.search,
    social: text.social,
    angle_used: text.angle_used,
    image_url: visual?.assets?.[0]?.url || null,
    images: visual?.assets || [],
  };

  return { text, visual, creative };
}

module.exports = {
  generateTextAds,
  generateBrandTextAds,
  generateVisualAds,
  generateBrandVisualAds,
  buildAdCreative,
  buildBrandAdCreative,
  loadCampaignContext,
  loadBrandContext,
};
