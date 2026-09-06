/// <reference types="jest" />
import {isJamEvidence} from '../lab/src/jamEvidence';
it('does not turn the first departure fix into a two-minute jam (9402 live regression)',()=>{
 expect(isJamEvidence({previousState:'at_stop',currentState:'on_track',axisAdvanceM:6.63,coordinateAdvanceM:12.5,nearStop:false})).toBe(false);
});
it('still recognizes repeated on-track standing, while either moving axis vetoes it',()=>{
 const pair={previousState:'on_track',currentState:'on_track',axisAdvanceM:3,coordinateAdvanceM:4,nearStop:false};
 expect(isJamEvidence(pair)).toBe(true);
 expect(isJamEvidence({...pair,axisAdvanceM:55})).toBe(false);
 expect(isJamEvidence({...pair,coordinateAdvanceM:80})).toBe(false);
 expect(isJamEvidence({...pair,nearStop:true})).toBe(false);
 expect(isJamEvidence({...pair,previousState:'unknown'})).toBe(false);
});
