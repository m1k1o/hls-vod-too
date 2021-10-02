import { MediaInfo } from '../src/MediaInfo';
import { expect } from 'chai';

var assert = require('assert');

describe('MediaInfo', function() {
  describe('convertToSegments', function() {
    it('should match basic segment iframes', function() {
      const expected = Float64Array.from([ 0, 3, 6, 9.5, 13, 16.5, 20, 22.75, 25.5, 28.25, 31 ]);
      const results = MediaInfo.convertToSegments(Float64Array.from([ 3, 6, 20 ]), 31);
      assert.deepEqual(results, expected);
    });

    it('difference between entries cannot be outside defined boundaries', function() {
      const segmentTimes = [
        [ 3.5, 1.25 ],
        [ 10, 5 ],
        [ 50, 1 ],
        [ 20, 19 ],
        [ 1, 0.5 ],
      ];

      const inputs = [
        [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ],
        [ 5, 55, 555 ],
        [ 1, 1, 1 ],
        [ 5, 1, 9 ],
        [ 10 ],
        [ 0, 10, 20 ]
      ]

      for (const [ segmentLength, segmentOffset ] of segmentTimes) {
        for (const input of inputs) {
          const duration = Number(input.pop())
          const results = MediaInfo.convertToSegments(Float64Array.from(input), duration, segmentLength, segmentOffset);
    
          let lastEl;
          for (const el of results) {
            if (lastEl) {
              expect(el - lastEl).to.be.at.least(segmentLength - segmentOffset)
              expect(el - lastEl).to.be.at.most(segmentLength + segmentOffset)
            }
    
            lastEl = el
          }
        }
      }

    });
  });
});
