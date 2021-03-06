/*
 *  Copyright 2016 Shaunak Kishore (kshaunak "at" gmail.com)
 *
 *  This file is part of Inkstone.
 *
 *  Inkstone is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  Inkstone is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with Inkstone.  If not, see <http://www.gnu.org/licenses/>.
 */

import {Settings} from '/client/model/settings';

const kCanvasSize = 512;

const kCornerSize = 1 / 8;
const kCrossWidth = 1 / 256;
const kMinDistance = 1 / 32;
const kStrokeWidth = 1 / 32;

const kBrushColor   = '#888888';
const kHintColor    = '#00c0ff';
const kRevealColor  = '#cccccc';
const kStrokeColor  = '#000000';

// Colors for EXCELLENT, GOOD, FAIR, and POOR result values.
const kResultColors = ['#84b4d8', '#88c874', '#c0c080', '#e87878'];

let ticker = null;

// Helper methods used by the handwriting class.

const angle = (xs) => Math.atan2(xs[1][1] - xs[0][1], xs[1][0] - xs[0][0]);

const animate = (shape, size, rotate, source, target) => {
  shape.regX = size * (target[0][0] + target[1][0]) / 2;
  shape.regY = size * (target[0][1] + target[1][1]) / 2;
  shape.x = size * (source[0][0] + source[1][0]) / 2;
  shape.y = size * (source[0][1] + source[1][1]) / 2;
  const scale = distance(source) / (distance(target) + kMinDistance);
  shape.scaleX = scale;
  shape.scaleY = scale;
  if (rotate) {
    const rotation = (180 / Math.PI) * (angle(source) - angle(target));
    shape.rotation = ((Math.round(rotation) + 540) % 360) - 180;
  }
  return {rotation: 0, scaleX: 1, scaleY: 1, x: shape.regX, y: shape.regY};
}

const convertShapeStyles = (shape, end) => {
  if (!shape.graphics || !shape.graphics.instructions) {
    return;
  }
  let updated = false;
  for (let instruction of shape.graphics.instructions) {
    if (instruction.style) {
      instruction.style = end;
      updated = true;
    }
  }
  if (updated) shape.updateCache();
}

const createCanvas = (element, handwriting) => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = kCanvasSize;
  canvas.style.width = canvas.style.height = `${element.width()}px`;
  element.append(canvas);

  const zoom = kCanvasSize / element.width();

  const getPosition = (touch) => {
    const bound = canvas.getBoundingClientRect();
    const point = [touch.clientX - bound.left, touch.clientY - bound.top];
    return point.map((x) => Math.round(zoom * x));
  }

  let mousedown = false;

  canvas.addEventListener('touchstart', (event) => {
    mousedown = true;
    if (event.cancelable) event.preventDefault();
    if (event.touches.length === 0) return;
    handwriting._pushPoint(getPosition(event.touches[0]));
  });

  canvas.addEventListener('touchmove', (event) => {
    if (!mousedown || event.touches.length === 0) return;
    handwriting._pushPoint(getPosition(event.touches[0]));
  }, {passive: true});

  canvas.addEventListener('touchend', (event) => {
    mousedown = false;
    handwriting._endStroke();
  });

  return canvas;
}

const distance = (xs) => {
  const diff = [xs[1][0] - xs[0][0], xs[1][1] - xs[0][1]];
  return Math.sqrt(diff[0] * diff[0] + diff[1] * diff[1]);
}

const dottedLine = (width, x1, y1, x2, y2) => {
  const result = new createjs.Shape();
  result.graphics.setStrokeDash([width, width], 0);
  result.graphics.setStrokeStyle(width)
  result.graphics.beginStroke('#ccc');
  result.graphics.moveTo(x1, y1);
  result.graphics.lineTo(x2, y2);
  return result;
}

const midpoint = (point1, point2) => {
  return [(point1[0] + point2[0]) / 2, (point1[1] + point2[1]) / 2];
}

const pathToShape = (path, size, color, uncached) => {
  const scale = 1024 / size;
  const result = new createjs.Shape();
  const tokens = path.split(' ');
  let index = 0;
  const next = () => {
    index += 2;
    let result = [tokens[index - 2], tokens[index - 1]];
    result = result.map((x) => parseInt(x, 10));
    result[1] = 900 - result[1];
    return result.map((x) => Math.round(x / scale));
  }
  const arity = {L: 1, M: 1, Q: 2, Z: 0};
  while (index < tokens.length) {
    index += 1;
    const command = tokens[index - 1];
    const args = _.range(arity[command] || 0).map(next);
    if (command === 'Z') {
      result.graphics.closePath();
    } else if (command === 'M') {
      result.graphics.beginFill(color);
      result.graphics.beginStroke(color);
      result.graphics.moveTo(args[0][0], args[0][1]);
    } else if (command === 'L') {
      result.graphics.lineTo(args[0][0], args[0][1]);
    } else if (command === 'Q') {
      result.graphics.curveTo(args[0][0], args[0][1], args[1][0], args[1][1]);
    } else {
      console.error(`Invalid command: ${command}`);
    }
  }
  if (!uncached) result.cache(0, 0, size, size);
  return result;
}

const renderCross = (size, container) => {
  const stroke = size * kCrossWidth;
  container.addChild(dottedLine(stroke, 0, 0, size, size));
  container.addChild(dottedLine(stroke, size, 0, 0, size));
  container.addChild(dottedLine(stroke, size / 2, 0, size / 2, size));
  container.addChild(dottedLine(stroke, 0, size/ 2, size, size / 2));
  container.cache(0, 0, size, size);
}

// A helper brush class that allows us to draw nice ink facsimiles.

class BasicBrush {
  constructor(container, point, options) {
    options = options || {};
    this._color = options.color || kBrushColor;
    this._width = options.width || 1;

    this._shape = new createjs.Shape();
    this._endpoint = point;
    this._midpoint = null;
    container.addChild(this._shape);
  }
  advance(point) {
    const last_endpoint = this._endpoint;
    const last_midpoint = this._midpoint;
    this._endpoint = point;
    this._midpoint = midpoint(last_endpoint, this._endpoint);
    if (last_midpoint) {
      this._draw(last_midpoint, this._midpoint, last_endpoint);
    } else {
      this._draw(last_endpoint, this._midpoint);
    }
  }
  _draw(point1, point2, control) {
    const graphics = this._shape.graphics;
    graphics.setStrokeStyle(this._width, 'round');
    graphics.beginStroke(this._color);
    graphics.moveTo(point1[0], point1[1]);
    if (control) {
      graphics.curveTo(control[0], control[1], point2[0], point2[1]);
    } else {
      graphics.lineTo(point2[0], point2[1]);
    }
  }
}

// Methods for actually executing drawing commands.

const Layer = {
  CROSS: 0,
  CORNER: 1,
  FADE: 2,
  WATERMARK: 3,
  HIGHLIGHT: 4,
  COMPLETE: 5,
  HINT: 6,
  STROKE: 7,
  WARNING: 8,
  ALL: 9,
};

class Handwriting {
  constructor(element, options) {
    this._onclick = options.onclick;
    this._ondouble = options.ondouble;
    this._onstroke = options.onstroke;

    this._settings = {};
    ['double_tap_speed', 'reveal_order', 'snap_strokes'].forEach(
        (x) => this._settings[x] = Settings.get(x));

    const canvas = createCanvas(element, this);
    this._stage = new createjs.Stage(canvas);
    this._size = this._stage.canvas.width;

    this._layers = [];
    for (let i = 0; i < Layer.ALL; i++) {
      const layer = new createjs.Container();
      this._layers.push(layer);
      this._stage.addChild(layer);
    }
    renderCross(this._size, this._layers[Layer.CROSS]);

    createjs.Ticker.timingMode = createjs.Ticker.RAF;
    createjs.Ticker.removeEventListener('tick', ticker);
    ticker = createjs.Ticker.addEventListener('tick', this._tick.bind(this));

    this.clear();
  }
  clear() {
    createjs.Tween.removeAllTweens();
    for (let layer of this._layers) {
      layer.removeAllChildren();
    }
    this._corner_characters = 0;
    this._drawable = true;
    this._emplacements = [];
    this._pending_animations = 0;
    this._running_animations = 0;
    this._reset();
  }
  emplace(args) {
    if (this._settings.snap_strokes) {
      this._emplace(args);
    } else {
      this._emplacements.push(args);
    }
  }
  fade() {
    const stroke = this._layers[Layer.STROKE];
    const child = stroke.children[stroke.children.length - 1];
    this._animate(child, {alpha: 0}, 150,
                  () => child.parent.removeChild(child));
  }
  flash(path) {
    const child = pathToShape(path, this._size, kHintColor);
    this._layers[Layer.HINT].addChild(child);
    this._animate(child, {alpha: 0}, 750,
                  () => child.parent.removeChild(child));
  }
  glow(result) {
    this._emplacements.forEach((args) => this._emplace(args));
    this._emplacements = [];
    const color = kResultColors[result] || kRevealColor;
    for (let child of this._layers[Layer.COMPLETE].children) {
      convertShapeStyles(child, color);
    }
    this.highlight();
    this._drawable = false;
  }
  highlight(path) {
    if (this._layers[Layer.WATERMARK].children.length === 0 ||
        !this._settings.reveal_order) {
      return;
    }
    const layer = this._layers[Layer.HIGHLIGHT];
    for (let child of layer.children) {
      this._animate(child, {alpha: 0}, 150, () => layer.removeChild(child));
    }
    if (path) {
      const child = pathToShape(path, this._size, kHintColor);
      child.alpha = 0;
      layer.addChild(child);
      this._animate(child, {alpha: 1}, 150);
    }
  }
  moveToCorner() {
    const children = this._layers[Layer.COMPLETE].children.slice();
    const container = new createjs.Container();
    children.forEach((child) => container.addChild(child));
    [Layer.WATERMARK, Layer.COMPLETE].forEach(
        (layer) => this._layers[layer].removeAllChildren());
    const endpoint = {scaleX: kCornerSize, scaleY: kCornerSize};
    endpoint.x = kCornerSize * this._size * this._corner_characters;
    this._layers[Layer.CORNER].addChild(container);
    this._animate(container, endpoint, 150);
    this._corner_characters += 1;
    this._drawable = true;
  }
  reveal(paths) {
    const layer = this._layers[Layer.WATERMARK];
    if (layer.children.length > 0) return;
    const container = new createjs.Container();
    for (let path of paths) {
      const child = pathToShape(
          path, this._size, kRevealColor, true /* uncached */);
      container.addChild(child);
    }
    container.cache(0, 0, this._size, this._size);
    layer.addChild(container);
  }
  undo() {
    this._layers[Layer.STROKE].children.pop();
    this._reset();
  }
  warn(warning) {
    const child = new createjs.Text(warning, '48px Georgia', kHintColor);
    const bounds = child.getBounds();
    child.x = (kCanvasSize - bounds.width) / 2;
    child.y = kCanvasSize - 2 * bounds.height;
    child.cache(0, 0, this._size, this._size);
    this._layers[Layer.WARNING].removeAllChildren();
    this._layers[Layer.WARNING].addChild(child);
    this._animate(child, {alpha: 0}, 1500,
                  () => child.parent && child.parent.removeChild(child));
  }
  _animate(shape, target, duration, callback) {
    this._running_animations += 1;
    createjs.Tween.get(shape).to(target, duration).call(() => {
      this._pending_animations += 1;
      callback && callback();
    });
  }
  _click() {
    const timestamp = new Date().getTime();
    const double_tap_speed = this._settings.double_tap_speed;
    const cutoff = (this._last_click_timestamp || 0) + double_tap_speed;
    const handler = timestamp < cutoff ? this._ondouble : this._onclick;
    this._last_click_timestamp = timestamp;
    handler && handler();
  }
  _emplace(args) {
    [path, rotate, source, target] = args;
    const child = pathToShape(path, this._size, kStrokeColor);
    const endpoint = animate(child, this._size, rotate, source, target);
    this._layers[Layer.STROKE].children.pop();
    this._layers[Layer.COMPLETE].addChild(child);
    this._animate(child, endpoint, 150);
  }
  _drawStroke() {
    if (this._stroke.length < 2) {
      return;
    }
    if (!this._settings.reveal_order) {
      this._fadeWatermark();
    }
    const n = this._stroke.length;
    if (!this._brush) {
      const layer = this._layers[Layer.STROKE];
      const options = {width: this._size * kStrokeWidth};
      this._brush = new BasicBrush(layer, this._stroke[n - 2], options);
    }
    this._brush.advance(this._stroke[n - 1]);
    this._stage.update();
  }
  _endStroke() {
    let handler = () => this._click();
    if (this._stroke.length >= 2) {
      const layer = this._layers[Layer.STROKE];
      const stroke = this._stroke.map((x) => x.map((y) => y / this._size));
      const n = stroke.length;
      if (_.any(stroke, (x) => distance([stroke[n - 1], x]) > kMinDistance)) {
        layer.children.forEach((x) => x.cache(0, 0, this._size, this._size));
        handler = () => this._onstroke && this._onstroke(stroke);
      } else {
        layer.removeAllChildren();
      }
    }
    handler();
    this._reset();
  }
  _fadeWatermark() {
    const children = this._layers[Layer.WATERMARK].children;
    if (children.length === 0) return;
    const child = children.pop();
    this._layers[Layer.FADE].addChild(child);
    this._animate(child, {alpha: 0}, 1500,
                  () => child.parent && child.parent.removeChild(child));
  }
  _pushPoint(point) {
    if (point[0] != null && point[1] != null) {
      this._stroke.push(point);
      if (this._drawable) this._drawStroke();
    }
  }
  _reset() {
    this._brush = null;
    this._stroke = [];
    this._stage.update();
  }
  _tick(event) {
    if (this._running_animations) {
      this._stage.update(event);
      this._running_animations -= this._pending_animations;
      this._pending_animations = 0;
    }
  }
}

export {Handwriting};
