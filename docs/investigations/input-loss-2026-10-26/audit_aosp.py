"""Run an upstream AOSP function on host-only stand-in events, never on a device.

Usage: python3 audit_aosp.py /path/to/PreferStylusOverTouchBlocker.cpp [output.json]
The upstream function is extracted unchanged; Android services, drivers and
feature selection are absent. This cannot establish the user's root cause.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

source_path = pathlib.Path(sys.argv[1])
source = source_path.read_text()
expected = "0732389e8f5a557011508587543577bbe837d52dd01dbd418934460341490645"
actual = hashlib.sha256(source.encode()).hexdigest()
if actual != expected:
    raise SystemExit("Unexpected upstream source: use the pinned source in platform-sources.json")

def extract(start, end):
    return source[source.index(start):source.index(end, source.index(start))]

tool_check = extract("static std::pair<bool, bool> checkToolType(", "/**")
process_motion = extract(
    "std::vector<NotifyMotionArgs> PreferStylusOverTouchBlocker::processMotion(",
    "void PreferStylusOverTouchBlocker::notifyInputDevicesChanged(",
)
prefix = r'''
#include <vector>
#include <set>
#include <map>
#include <utility>
#include <iostream>
#include <cassert>
using std::size_t;
using int32_t=int;
enum class ToolType { FINGER, STYLUS };
bool isStylusToolType(ToolType t){return t==ToolType::STYLUS;}
enum { AMOTION_EVENT_ACTION_DOWN=0, AMOTION_EVENT_ACTION_UP=1,
 AMOTION_EVENT_ACTION_MOVE=2, AMOTION_EVENT_ACTION_CANCEL=3,
 AMOTION_EVENT_ACTION_HOVER_ENTER=9, AMOTION_EVENT_ACTION_HOVER_EXIT=10,
 AMOTION_EVENT_FLAG_CANCELED=32, SYSTEM_TIME_MONOTONIC=1 };
long long systemTime(int){return 123456;}
constexpr bool BLOCK_TOUCH_WHEN_STYLUS_HOVER=AUDIT_BLOCK_HOVER;
struct PointerProperties { ToolType toolType; };
struct NotifyMotionArgs {
 int deviceId=0,action=0,flags=0;long long eventTime=0;
 std::vector<PointerProperties> pointerProperties;
 size_t getPointerCount() const{return pointerProperties.size();}
};
class PreferStylusOverTouchBlocker {
 std::set<int> mActiveStyli,mCanceledDevices,mDevicesWithMixedToolType;
 std::map<int,NotifyMotionArgs> mLastTouchEvents;
 public: std::vector<NotifyMotionArgs> processMotion(const NotifyMotionArgs&);
};
NotifyMotionArgs pen(int action){return {1,action,0,0,{{ToolType::STYLUS}}};}
NotifyMotionArgs touch(int action){return {2,action,0,0,{{ToolType::FINGER}}};}
'''
suffix = r'''
int main(){
 PreferStylusOverTouchBlocker first;
 auto a=first.processMotion(pen(AMOTION_EVENT_ACTION_DOWN));
 auto b=first.processMotion(touch(AMOTION_EVENT_ACTION_DOWN));
 auto c=first.processMotion(pen(AMOTION_EVENT_ACTION_UP));
 auto d=first.processMotion(touch(AMOTION_EVENT_ACTION_MOVE));
 auto e=first.processMotion(touch(AMOTION_EVENT_ACTION_UP));
 auto f=first.processMotion(touch(AMOTION_EVENT_ACTION_DOWN));
 assert(a.size()==1&&b.empty()&&c.size()==1&&d.empty()&&e.empty()&&f.size()==1);
 PreferStylusOverTouchBlocker second;
 second.processMotion(pen(AMOTION_EVENT_ACTION_DOWN));
 second.processMotion(pen(AMOTION_EVENT_ACTION_UP));
 auto fresh=second.processMotion(touch(AMOTION_EVENT_ACTION_DOWN));
 assert(fresh.size()==1);
 PreferStylusOverTouchBlocker third;
 third.processMotion(pen(AMOTION_EVENT_ACTION_HOVER_ENTER));
 auto during=third.processMotion(touch(AMOTION_EVENT_ACTION_DOWN));
 third.processMotion(pen(AMOTION_EVENT_ACTION_HOVER_EXIT));
 auto held=third.processMotion(touch(AMOTION_EVENT_ACTION_MOVE));
 third.processMotion(touch(AMOTION_EVENT_ACTION_UP));
 auto retry=third.processMotion(touch(AMOTION_EVENT_ACTION_DOWN));
 assert(during.size()==(BLOCK_TOUCH_WHEN_STYLUS_HOVER?0:1));
 assert(held.size()==(BLOCK_TOUCH_WHEN_STYLUS_HOVER?0:1));assert(retry.size()==1);
 PreferStylusOverTouchBlocker fourth;
 auto mixed=fourth.processMotion({3,AMOTION_EVENT_ACTION_DOWN,0,0,{{ToolType::STYLUS},{ToolType::FINGER}}});
 assert(mixed.size()==1);
 std::cout<<"{\"blockHover\":"<<(BLOCK_TOUCH_WHEN_STYLUS_HOVER?"true":"false")
 <<",\"touchDownDuringPenDelivered\":"<<b.size()
 <<",\"sameHeldTouchAfterPenUpDelivered\":"<<d.size()
 <<",\"freshTouchAfterPenUpDelivered\":"<<fresh.size()
 <<",\"touchDuringHoverDelivered\":"<<during.size()
 <<",\"sameHeldTouchAfterHoverExitDelivered\":"<<held.size()
 <<",\"retryAfterLiftingFingerDelivered\":"<<retry.size()
 <<",\"mixedToolDeviceEventDelivered\":"<<mixed.size()<<"}";
}
'''
with tempfile.TemporaryDirectory(prefix="illustro-aosp-audit-") as scratch:
    cpp = pathlib.Path(scratch, "audit.cpp")
    cpp.write_text(prefix + tool_check + process_motion + suffix)
    results = []
    for flag in (0, 1):
        binary = pathlib.Path(scratch, f"audit-{flag}")
        subprocess.run(["g++", "-std=c++17", f"-DAUDIT_BLOCK_HOVER={flag}", str(cpp), "-o", str(binary)], check=True)
        results.append(json.loads(subprocess.check_output([str(binary)], text=True)))

report = {
    "scope": "Exact upstream processMotion/checkToolType with stand-in event types, clocks and feature flag, compiled on host. NOT the device's Android implementation or input trace.",
    "source_commit": "4f463a6b1de9198963dc6aff74154a504ba3f8f6",
    "source_sha256": actual,
    "results": results,
    "rootCauseIdentified": False,
    "implications": [
        "This function can remove finger events before the web page while stylus events continue.",
        "Once this function cancels a held finger gesture, stylus release alone does not restore that gesture; lift and a fresh contact are required.",
        "A fresh contact after pen up can pass immediately in these inputs. This function alone is not proof of a fixed post-pen timeout.",
        "No measured evidence shows that the user's device selected this function, these flags or these input sequences.",
    ],
}
target = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(__file__).with_name("evidence") / "aosp-function-audit.json"
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
