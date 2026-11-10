import { describe, expect, it } from 'vitest';
import { boxFromFeet, collidesWithWorld, intersects, moveBox } from '../../shared/physics/aabb.js';

const floorAt0 = (_x: number, y: number) => y < 0;

describe('axis-aligned bounding boxes', () => {
  it('builds a box from feet position, width and height', () => {
    const b = boxFromFeet(10, 5, -3, 0.6, 1.8);
    expect(b.minX).toBeCloseTo(9.7);
    expect(b.maxX).toBeCloseTo(10.3);
    expect(b.minY).toBe(5);
    expect(b.maxY).toBeCloseTo(6.8);
    expect(b.minZ).toBeCloseTo(-3.3);
    expect(b.maxZ).toBeCloseTo(-2.7);
  });

  it('treats touching faces as non-overlapping and real overlap as intersecting', () => {
    const a = boxFromFeet(0, 0, 0, 1, 1);
    expect(intersects(a, boxFromFeet(1, 0, 0, 1, 1))).toBe(false);
    expect(intersects(a, boxFromFeet(0.5, 0, 0, 1, 1))).toBe(true);
    expect(intersects(a, boxFromFeet(0.5, 1, 0, 1, 1))).toBe(false);
  });

  it('lands a falling box exactly on the floor and reports the Y collision', () => {
    const r = moveBox(boxFromFeet(0.5, 2, 0.5, 0.6, 1.8), 0, -3, 0, floorAt0);
    expect(r.box.minY).toBeCloseTo(0, 5);
    expect(r.collidedY).toBe(true);
  });

  it('moves freely through open space without collisions', () => {
    const r = moveBox(boxFromFeet(0.5, 5, 0.5, 0.6, 1.8), 1, 0, -2, () => false);
    expect(r.box.minX).toBeCloseTo(1.2);
    expect(r.box.minZ).toBeCloseTo(-1.8);
    expect(r.collidedX || r.collidedZ || r.collidedY).toBe(false);
  });

  it('stops at a wall without passing through it', () => {
    const wall = (x: number) => x >= 5;
    const r = moveBox(boxFromFeet(4.2, 0, 0, 0.6, 1.8), 2, 0, 0, wall);
    expect(r.box.maxX).toBeLessThanOrEqual(5 + 1e-6);
    expect(r.collidedX).toBe(true);
  });

  it('detects when a box overlaps solid blocks', () => {
    expect(collidesWithWorld(boxFromFeet(0.5, -0.5, 0.5, 0.6, 1.8), floorAt0)).toBe(true);
    expect(collidesWithWorld(boxFromFeet(0.5, 0.5, 0.5, 0.6, 1.8), floorAt0)).toBe(false);
  });
});
