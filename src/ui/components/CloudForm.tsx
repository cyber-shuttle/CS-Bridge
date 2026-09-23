import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Stack, Text, Button, SingleSelect, Option } from '@/ui/components/base';
import { post } from '@/ui/platform/vscode';

export type CloudFormInitial = {
    instanceType?: string;
    osImage?: string;
    region?: string
    vendor: string
};

interface CloudOptions {
    images: string[][],
    instanceTypes: string[][],
    vendors: string[][]
    regions: string[][]
}

interface Props {
    options: CloudOptions
    validating?: boolean;
}

function Select({ label, value, onChange, options, children }: { label: string; value: string; onChange: (v: string) => void; options?: string[][]; children?: ComponentChildren }) {
    return (
        <Stack gap={2}>
            <Text weight={600} size={12}>{label}</Text>
            <SingleSelect value={value} style={{ width: '100%', maxWidth: 'none' }} onChange={onChange}>
                {options ? options.map(([v, l]) => <Option key={v} value={v}>{l}</Option>) : children}
            </SingleSelect>
        </Stack>
    );
}

function CloudFormFields({ options, validating }: { options: CloudOptions, validating?: boolean }) {

    const [osImageName, setOsImageName] = useState("");
    const [instanceType, setInstanceType] = useState("");
    const [region, setRegion] = useState("");
    const [vendor, setVendor] = useState("");


    const submit = () => {
        post({
            command: "launchInstance"
        });
    };

    return (
        <Stack gap={4}>

            <Select label="Instance Type" value={instanceType} onChange={setInstanceType} options={options.instanceTypes} />
            <Select label="OS Image" value={osImageName} onChange={setOsImageName} options={options.images} />
            <Select label="Region" value={region} onChange={setRegion} options={options.regions} />
            <Select label="vendor" value={vendor} onChange={setVendor} options={options.vendors} />
            <Button onClick={submit} disabled={validating}>
            </Button>
        </Stack>
    );
}

export function CloudForm({ options, validating }: Props) {
    <CloudFormFields options={options} validating={validating} />;
}

