"""Small SDF ray-marcher and tile helpers for icon renders (soft plastic material)."""
import numpy as np
from PIL import Image, ImageDraw


def _normalize(v):
    return v / np.linalg.norm(v, axis=-1, keepdims=True).clip(1e-9)


def _rotation(ax, ay):
    ax, ay = np.radians(ax), np.radians(ay)
    rx = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    return ry @ rx


def rounded_box(p, centre, half, radius):
    q = np.abs(p - np.asarray(centre, float)) - (np.asarray(half, float) - radius)
    return np.linalg.norm(np.maximum(q, 0), axis=1) + np.minimum(q.max(axis=1), 0) - radius


def render_sdf(scene, size, top_colour, bottom_colour, tilt=(-5, 5), supersample=2, steps=110):
    """Render `scene(p) -> distance` over the [-1, 1] square as an RGBA image of `size` px."""
    n = size * supersample
    ys, xs = np.mgrid[0:n, 0:n]
    u = (xs + 0.5) / n * 2 - 1
    v = 1 - (ys + 0.5) / n * 2
    rot = _rotation(*tilt)
    origin = np.stack([u, v, np.full_like(u, 4.0)], -1).reshape(-1, 3) @ rot.T
    direction = np.array([0, 0, -1.0]) @ rot.T
    t = np.zeros(len(origin))
    hit = np.zeros(len(origin), bool)
    alive = np.ones(len(origin), bool)
    for _ in range(steps):
        idx = np.flatnonzero(alive)
        if idx.size == 0:
            break
        d = scene(origin[idx] + direction * t[idx, None])
        t[idx] += d * 0.9
        done = d < 1e-3
        hit[idx[done]] = True
        alive[idx[done]] = False
        alive[idx[t[idx] > 8]] = False
    rgba = np.zeros((len(origin), 4))
    h = np.flatnonzero(hit)
    p = origin[h] + direction * t[h, None]
    normal = _normalize(np.stack([scene(p + e) - scene(p - e) for e in np.eye(3) * 1e-3], -1))
    view = -np.broadcast_to(direction, p.shape)
    ao = np.ones(len(h))
    for i in range(1, 6):
        step = 0.03 * i
        ao -= (step - scene(p + normal * step)).clip(0) * (1.6 / i)
    ao = ao.clip(0.35, 1)[:, None]
    height = ((p @ rot)[:, 1] * 0.5 + 0.5).clip(0, 1)[:, None]
    base = np.asarray(bottom_colour) * (1 - height) + np.asarray(top_colour) * height
    key = _normalize(np.array([-0.45, 0.75, 0.6]))
    fill = _normalize(np.array([0.7, -0.2, 0.5]))
    wrap = ((normal @ key) * 0.5 + 0.5)[:, None] ** 1.4
    diffuse = base * (0.38 + 0.72 * wrap + 0.25 * (normal @ fill).clip(0)[:, None])
    n_dot_h = (normal * _normalize(key + view)).sum(1).clip(0)[:, None]
    fresnel = (1 - (normal * view).sum(1).clip(0))[:, None] ** 3
    rgba[h, :3] = diffuse * ao + 0.55 * n_dot_h ** 90 + 0.12 * n_dot_h ** 6 + 0.25 * fresnel
    rgba[h, 3] = 1
    image = Image.fromarray((rgba.reshape(n, n, 4).clip(0, 1) * 255).astype(np.uint8), 'RGBA')
    return image.resize((size, size), Image.LANCZOS)


def squircle_mask(size, radius_fraction=58 / 256):
    big = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        [0, 0, size * 4 - 1, size * 4 - 1], radius=int(size * 4 * radius_fraction), fill=255)
    return big.resize((size, size), Image.LANCZOS)


def diagonal_gradient(size, start, end, diagonal=0.35):
    y, x = np.mgrid[0:size, 0:size] / (size - 1)
    t = (y * (1 - diagonal) + x * diagonal)[..., None]
    colours = np.asarray(start) * (1 - t) + np.asarray(end) * t
    return Image.fromarray((colours * 255).astype(np.uint8), 'RGB').convert('RGBA')


def top_gloss(size, strength=0.16):
    y = np.linspace(1, 0, size)[:, None].repeat(size, 1)
    alpha = (y.clip(0.55, 1) - 0.55) / 0.45 * strength
    return Image.fromarray((np.dstack([np.ones((size, size, 3)), alpha]) * 255).astype(np.uint8), 'RGBA')
