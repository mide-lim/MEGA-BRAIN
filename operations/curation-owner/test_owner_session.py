import importlib.util,pathlib,subprocess,unittest
from unittest.mock import patch
PATH=pathlib.Path(__file__).with_name('apply-reels-curation-owner-session.py')
spec=importlib.util.spec_from_file_location('curation_owner_session',PATH);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
TOKEN='synthetic.owner.token.never.real'
BASE_AUTH=" sys.path.insert(0,'/opt/megabrain-v0-builds/release-20261004-pilot/scripts')\n from megabrain_google_auth import load_scoped_adc\n import google.auth\n from google.auth.transport.requests import AuthorizedSession\n credentials,_=google.auth.load_credentials_from_dict(load_scoped_adc('deploy'if args.apply else'read'),scopes=['https://www.googleapis.com/auth/cloud-platform'])\n"
class OwnerSessionAuthentication(unittest.TestCase):
 def test_transport_preserves_every_non_authentication_byte_of_reviewed_operator(self):
  root=PATH.parents[2];original=(root/'ops/apply-reels-curation.py').read_text();variant=PATH.read_text()
  begin=variant.index('# BEGIN OWNER SESSION AUTH');end=variant.index('# END OWNER SESSION AUTH')+len('# END OWNER SESSION AUTH\n')
  stripped=variant[:begin]+variant[end:]
  stripped=stripped.replace('\n\ndef main():','\ndef main():')
  stripped=stripped.replace(' from google.auth.transport.requests import AuthorizedSession\n credentials=owner_session_credentials(args.package_sha256)\n',BASE_AUTH)
  self.assertEqual(stripped,original)
 def test_exact_active_owner_uses_only_captured_token_without_refresh_configuration(self):
  with patch('subprocess.run',side_effect=[subprocess.CompletedProcess([],0,module.OWNER_ACCOUNT+'\n',''),subprocess.CompletedProcess([],0,TOKEN+'\n','')])as run:
   credentials=module.owner_session_credentials(module.OWNER_PACKAGE_SHA256)
  self.assertEqual(credentials.token,TOKEN);self.assertIsNone(credentials.refresh_token)
  self.assertEqual(run.call_count,2)
  self.assertEqual(run.call_args_list[0].args[0],['gcloud','auth','list','--filter=status:ACTIVE','--format=value(account)','--quiet'])
  self.assertEqual(run.call_args_list[1].args[0],['gcloud','auth','print-access-token','--account='+module.OWNER_ACCOUNT,'--project='+module.PROJECT,'--quiet'])
  for call in run.call_args_list:
   self.assertTrue(call.kwargs['capture_output']);self.assertTrue(call.kwargs['check']);self.assertEqual(call.kwargs['timeout'],30)
 def test_wrong_empty_or_multiple_active_accounts_never_request_a_token(self):
  for active in ['', 'other@example.test\n',module.OWNER_ACCOUNT+'\nother@example.test\n']:
   with self.subTest(active=active),patch('subprocess.run',return_value=subprocess.CompletedProcess([],0,active,''))as run:
    with self.assertRaisesRegex(ValueError,'active owner account'):module.owner_session_credentials(module.OWNER_PACKAGE_SHA256)
    self.assertEqual(run.call_count,1)
 def test_failed_session_or_token_emits_no_captured_output_and_never_retries(self):
  cases=[[subprocess.CalledProcessError(1,['gcloud'],output=TOKEN,stderr=TOKEN)],[subprocess.CompletedProcess([],0,module.OWNER_ACCOUNT,''),subprocess.CalledProcessError(1,['gcloud'],output=TOKEN,stderr=TOKEN)]]
  for answers in cases:
   with patch('subprocess.run',side_effect=answers)as run:
    with self.assertRaises(ValueError)as failure:module.owner_session_credentials(module.OWNER_PACKAGE_SHA256)
    self.assertNotIn(TOKEN,str(failure.exception));self.assertIsNone(failure.exception.__cause__);self.assertTrue(failure.exception.__suppress_context__)
    self.assertEqual(run.call_count,len(answers))
 def test_unsealed_package_and_malformed_token_fail_before_cloud_requests(self):
  with patch('subprocess.run')as run:
   with self.assertRaisesRegex(ValueError,'sealed'):module.owner_session_credentials('0'*64)
   run.assert_not_called()
  for token in ['',TOKEN+'\nsecond', ' ']:
   with patch('subprocess.run',side_effect=[subprocess.CompletedProcess([],0,module.OWNER_ACCOUNT,''),subprocess.CompletedProcess([],0,token,'')])as run:
    with self.assertRaisesRegex(ValueError,'token is invalid'):module.owner_session_credentials(module.OWNER_PACKAGE_SHA256)
    self.assertEqual(run.call_count,2)
if __name__=='__main__':unittest.main()
