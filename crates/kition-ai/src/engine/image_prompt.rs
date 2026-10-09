//! Scaffolding wrapped around user image prompts so the model always gets
//! a style, composition, and constraint baseline for the use case.

struct Preset {
    asset_type: &'static str,
    style: &'static str,
    composition: &'static str,
    lighting: &'static str,
    constraints: &'static [&'static str],
    avoid: &'static [&'static str],
}

const SHARED_CONSTRAINTS: &[&str] = &[
    "No readable text, labels, logos, watermarks, or QR codes",
    "No real faces or identifiable people",
    "No emoji or cartoon faces",
];
const INFOGRAPHIC_CONSTRAINTS: &[&str] = &[
    "Only labels wrapped in quotes within the Primary request may appear verbatim; all other text is forbidden",
    "No real faces or identifiable people",
    "No emoji or cartoon faces",
];
const SHARED_AVOID: &[&str] = &[
    "Generic AI-illustration tropes (blob shapes, gradient halos, cyberpunk neon)",
    "Over-reflective metal, plastic-looking gradients",
    "Any single color flooding the whole frame (purple-bubble background, blue-neon background, etc.)",
];
const COVER_AVOID: &[&str] = &[
    "Generic AI-illustration tropes (blob shapes, gradient halos, cyberpunk neon)",
    "Over-reflective metal, plastic-looking gradients",
    "Full-bleed single-color background; purple is the lead color but negative space is still required",
];

/// The known use cases; anything else is an inline illustration.
pub fn parse_use_case(raw: &str) -> &'static str {
    match raw.trim() {
        "cover_illustration" => "cover_illustration",
        "infographic_diagram" => "infographic_diagram",
        "product_showcase" => "product_showcase",
        "icon_brand" => "icon_brand",
        "other" => "other",
        _ => "inline_illustration",
    }
}

fn preset(use_case: &str) -> Preset {
    match use_case {
        "cover_illustration" => Preset {
            asset_type: "blog / newsletter hero illustration",
            style: "Purple-led palette (around #7C3AED) with teal/amber accents; cinematic editorial illustration, clean geometry + light 3D, not cartoon",
            composition: "Single subject offset to the right third, generous left margin for a title; 16:9 landscape",
            lighting: "Mixed warm/cool light, warm tone as the key light",
            constraints: SHARED_CONSTRAINTS,
            avoid: COVER_AVOID,
        },
        "infographic_diagram" => Preset {
            asset_type: "infographic / flowchart / comparison diagram",
            style: "Flat vector style, high contrast, nodes + connectors; no gradients, not photorealistic",
            composition: "Top-to-bottom or left-to-right flow, nodes strictly aligned to an invisible grid",
            lighting: "Purely flat, no shading",
            constraints: INFOGRAPHIC_CONSTRAINTS,
            avoid: SHARED_AVOID,
        },
        "product_showcase" => Preset {
            asset_type: "product / UI / packaging showcase",
            style: "Neutral background (off-white or #f5f5f7), realistic materials, studio light",
            composition: "Subject centered or on a third; slight perspective angle",
            lighting: "Softbox lighting, controlled highlights, soft shadows",
            constraints: SHARED_CONSTRAINTS,
            avoid: SHARED_AVOID,
        },
        "icon_brand" => Preset {
            asset_type: "single icon / logo / symbol",
            style: "Single symbol, flat color blocks, strong silhouette, scalable and legible at small sizes",
            composition: "Centered, generous padding on all sides; not touching edges",
            lighting: "Purely flat, no shading",
            constraints: SHARED_CONSTRAINTS,
            avoid: SHARED_AVOID,
        },
        "other" => Preset {
            asset_type: "general image",
            style: "Driven by the Primary request",
            composition: "Driven by the Primary request",
            lighting: "Driven by the Primary request",
            constraints: SHARED_CONSTRAINTS,
            avoid: SHARED_AVOID,
        },
        _ => Preset {
            asset_type: "in-article body illustration",
            style: "Driven by the Primary request, no preset lead color; clean geometry + light 3D, editorial-illustration feel, not cartoon",
            composition: "Horizontally centered, single focal point, ~10% negative space on each side",
            lighting: "Mixed warm/cool light, warm tone as the key light",
            constraints: SHARED_CONSTRAINTS,
            avoid: SHARED_AVOID,
        },
    }
}

/// The labeled-line prompt sent to the image model.
pub fn wrap(user_prompt: &str, use_case: &str, aspect_hint: &str) -> String {
    let use_case = parse_use_case(use_case);
    let preset = preset(use_case);
    let mut out = format!(
        "Use case: {use_case}\nPrimary request: {user_prompt}\nAsset type: {}\nStyle: {}\nComposition: {}\nLighting: {}\n",
        preset.asset_type, preset.style, preset.composition, preset.lighting
    );
    if !aspect_hint.trim().is_empty() {
        out.push_str(&format!("Aspect: {}\n", aspect_hint.trim()));
    }
    out.push_str("Constraints:\n");
    for line in preset.constraints {
        out.push_str(&format!("  - {line}\n"));
    }
    out.push_str("Avoid:\n");
    for line in preset.avoid {
        out.push_str(&format!("  - {line}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_with_presets() {
        let prompt = wrap("A fox", "unknown", "1024x1024");
        assert!(prompt.starts_with("Use case: inline_illustration\nPrimary request: A fox\n"));
        assert!(prompt.contains("Aspect: 1024x1024\n"));
        assert!(wrap("x", "cover_illustration", "").contains("Purple-led palette"));
    }
}
