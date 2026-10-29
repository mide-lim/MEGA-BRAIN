import json,unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tool_evidence import command_printed_marker,standalone_marker
CMD='bash /reference/validate_offline.sh'
MARKER='HERMES_OFFLINE_TESTS_PASSED'
def transcript(command=CMD,code=0,output=MARKER,call_id='call-1'):
    return [{'role':'assistant','tool_calls':[{'id':'call-1','function':{
        'name':'terminal','arguments':json.dumps({'command':command})}}]},
        {'role':'tool','tool_call_id':call_id,'content':json.dumps({'output':output,'exit_code':code,'error':None})}]
class EvidenceTests(unittest.TestCase):
    def test_actual_success(self):self.assertTrue(command_printed_marker(transcript(),CMD,MARKER))
    def test_quoted_script_is_not_execution(self):
        self.assertFalse(command_printed_marker(transcript(command='cat /reference/validate_offline.sh'),CMD,MARKER))
    def test_failed_command_cannot_claim_success(self):
        self.assertFalse(command_printed_marker(transcript(code=1),CMD,MARKER))
    def test_unmatched_tool_result_rejected(self):
        self.assertFalse(command_printed_marker(transcript(call_id='other'),CMD,MARKER))
    def test_marker_must_be_a_complete_output_line(self):
        self.assertFalse(command_printed_marker(transcript(output='quoted '+MARKER),CMD,MARKER))
    def test_negative_review_cannot_quote_approval(self):
        self.assertFalse(standalone_marker('Not approved; do not output `HERMES_VALIDATION_APPROVED`.','HERMES_VALIDATION_APPROVED'))
    def test_explicit_review_approval(self):
        self.assertTrue(standalone_marker('Checks passed.\nHERMES_VALIDATION_APPROVED\n','HERMES_VALIDATION_APPROVED'))
if __name__=='__main__':unittest.main()
