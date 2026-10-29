"""Audit actual serialized request, not only local JSON Schema.

Supplied official reference: /reference/VERTEX-SECOND-PILOT-REFERENCE.json
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding
https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/rest/v1/Schema
Offline schema validity is not proof of live provider acceptance or audio codec.
"""
import base64
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import provider
from cloud_adapter import provider_schema, endpoint
from common import ContractError


class VertexRequestTests(unittest.TestCase):
    def setUp(self):
        self.task = json.loads((provider.LIVE / 'examples/stored-video.preparation.json').read_bytes())
        self.data = b'SYNTHETIC TEST BYTES. NOT MP4; no real media or transcript.'
        self.body = json.loads(provider.request_bytes(self.task, self.data))
        self.local = json.loads((provider.LIVE / 'contracts/model-payload.v1.schema.json').read_bytes())

    def test_complete_serialized_schema_all_nodes_and_ten_enums(self):
        enums = []
        allowed = {'type','enum','nullable','properties','items','required','minimum','maximum',
                   'description','format','minItems','maxItems','anyOf','propertyOrdering'}
        types = {'STRING','NUMBER','INTEGER','BOOLEAN','OBJECT','ARRAY'}
        def visit(local, wire, path):
            self.assertLessEqual(set(wire), allowed, path)
            self.assertIn(wire['type'], types, path)
            if 'anyOf' in local:
                self.assertTrue(wire['nullable'], path)
                local = next(x for x in local['anyOf'] if x != {'type':'null'})
            if isinstance(local.get('type'), list):
                self.assertTrue(wire['nullable'], path)
            if 'enum' in local:
                self.assertEqual(wire['type'], 'STRING', path)
                self.assertEqual(wire['enum'], local['enum'], path)
                enums.append(path)
            for key in ('required', 'minimum', 'maximum'):
                if key in local: self.assertEqual(wire[key], local[key], path)
            if 'properties' in wire:
                self.assertEqual(wire['type'], 'OBJECT', path)
                self.assertEqual(set(wire['properties']), set(local['properties']), path)
                self.assertLessEqual(set(wire.get('required', [])), set(wire['properties']), path)
                for key, child in wire['properties'].items(): visit(local['properties'][key], child, path+'.'+key)
            if 'items' in wire:
                self.assertEqual(wire['type'], 'ARRAY', path)
                visit(local['items'], wire['items'], path+'[]')
        visit(self.local, self.body['generationConfig']['responseSchema'], '$')
        self.assertEqual(len(enums), 10)

    def test_exact_body_media_prompt_and_static_configuration(self):
        self.assertEqual(set(self.body), {'contents','generationConfig'})
        self.assertEqual(len(self.body['contents']), 1)
        content = self.body['contents'][0]
        self.assertEqual(set(content), {'role','parts'}); self.assertEqual(content['role'], 'user')
        self.assertEqual(len(content['parts']), 2)
        media, text = content['parts']
        self.assertEqual(set(media), {'inlineData','mediaProcessing','videoMetadata'})
        self.assertEqual(set(media['inlineData']), {'mimeType','data'})
        self.assertEqual(media['inlineData']['mimeType'], 'video/mp4')
        self.assertEqual(base64.b64decode(media['inlineData']['data'], validate=True), self.data)
        self.assertEqual(media['mediaProcessing'], 'STATIC')
        self.assertEqual(media['videoMetadata'], {'fps':1})
        self.assertEqual(text, {'text':(provider.LIVE / 'prompts/stored-multimodal.v1.txt').read_text()})
        config = copy.deepcopy(self.body['generationConfig']); config.pop('responseSchema')
        self.assertEqual(config, {'mediaResolution':'MEDIA_RESOLUTION_LOW', 'responseMimeType':'application/json',
                                 'thinkingConfig':{'thinkingLevel':'LOW'}, 'maxOutputTokens':4096})

    def test_target_and_unsupported_configuration(self):
        project = self.task['cloud']['project_id']
        self.assertEqual(endpoint(self.task), 'https://aiplatform.googleapis.com/v1beta1/projects/'+project+
            '/locations/global/publishers/google/models/gemini-3.8-flash:generateContent')
        for key, value in [('model','other'), ('location','us-central1'), ('api_version','v1')]:
            task = copy.deepcopy(self.task); task['cloud'][key] = value
            with self.assertRaises(ContractError): provider.request_bytes(task, self.data)
        for key in ('temperature','topP','topK','candidateCount','frequencyPenalty','presencePenalty'):
            value = copy.deepcopy(self.body); value['generationConfig'][key] = 1
            with mock.patch.object(provider, 'build_request', return_value=value), self.assertRaises(ContractError):
                provider.request_bytes(self.task, self.data)

    def test_size_caps_and_unsupported_schema(self):
        for data in (b'', 'not bytes', b'x'*(provider.MAX_MEDIA_BYTES+1)):
            with self.assertRaises(ContractError): provider.request_bytes(self.task, data)
        with mock.patch.object(provider, 'MAX_REQUEST_BYTES', 1), self.assertRaises(ContractError):
            provider.request_bytes(self.task, self.data)
        for schema in ({'type':'null'}, {'enum':[1]}, {'enum':['a','a']},
                       {'anyOf':[{'type':'string'},{'type':'integer'}]}, {'type':['string','integer']}):
            with self.assertRaises(ContractError): provider_schema(schema)


if __name__ == '__main__':
    unittest.main()
