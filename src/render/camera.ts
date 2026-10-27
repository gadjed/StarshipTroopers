/**
 * Ортографічна камера згори. Усі розміри — у фізичних пікселях канвасу.
 * Світова вісь Y спрямована вниз (як на екрані), тож миша мапиться без перевертань.
 */
export class Camera {
  x = 500;
  y = 500;
  /** Пікселів на світову одиницю. */
  zoom = 1;
  viewW = 1;
  viewH = 1;
  minZoom = 0.05;
  maxZoom = 200;

  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  fit(worldSize: number): void {
    this.zoom = Math.min(this.viewW, this.viewH) / (worldSize * 1.08);
    this.minZoom = this.zoom * 0.3;
    this.x = worldSize / 2;
    this.y = worldSize / 2;
  }

  screenToWorldX(sx: number): number {
    return this.x + (sx - this.viewW * 0.5) / this.zoom;
  }

  screenToWorldY(sy: number): number {
    return this.y + (sy - this.viewH * 0.5) / this.zoom;
  }

  pan(dxPx: number, dyPx: number): void {
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
  }

  /** Масштабування з якорем у точці під курсором. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const wx = this.screenToWorldX(sx);
    const wy = this.screenToWorldY(sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    this.x = wx - (sx - this.viewW * 0.5) / this.zoom;
    this.y = wy - (sy - this.viewH * 0.5) / this.zoom;
  }
}
